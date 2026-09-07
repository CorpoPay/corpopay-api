/**
 * Refund persistence — the ledger clawback for a refunded card capture.
 *
 * A full refund unwinds the capture's settlement: it moves the capture's net
 * (`AVAILABLE`), fee (`FEES`), and reserve (`RESERVE`) credits back to `CASH`, so
 * the money leaves the tenant's payout-eligible balance (a refunded payment must
 * never be paid out) and CorpoPay does not keep its commission on refunded money.
 *
 * Idempotent by `refundId` (the `Refund` row is the source of truth; a replayed
 * webhook or retry is a no-op). Amounts cross this boundary as integer centimes;
 * the DB stores MAD `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { LedgerAccount } from "@/generated/prisma/client";

import { AppError } from "../middleware/errorHandler";
import { credit, debit, posting } from "./ledger";
import { accountBalanceCents, postEntry } from "./ledger-db";
import { centimes, madToCentimes } from "./money";
import { prisma } from "./prisma";

/** A capture's settlement credits — a full refund reverses all three. */
const REFUNDED_ACCOUNTS: LedgerAccount[] = ["AVAILABLE", "FEES", "RESERVE"];

export interface SettleRefundInput {
  /** The capture's `PaymentIntent.id` — joins the reversal to its settlement legs. */
  intentId: string;
  /** The `Refund.id` — the idempotency key for the clawback. */
  refundId: string;
}

/**
 * Reverse a successful capture's settlement into the ledger.
 *
 * Returns `{ settled: true }` the first time and `{ settled: false }` on a replay
 * or when there is no capture settlement to reverse (e.g. a direct intent that
 * was never settled). Throws `REFUND_AFTER_PAYOUT` if the net has already been
 * paid out — refunding would over-draw `AVAILABLE`.
 */
export async function settleRefund(
  tenantId: string,
  input: SettleRefundInput,
): Promise<{ settled: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    const existing = await tx.ledgerEntry.findFirst({
      where: { tenantId, sourceType: "refund", sourceId: input.refundId },
      select: { id: true },
    });
    if (existing) return { settled: false };

    const credits = await tx.ledgerEntry.findMany({
      where: {
        tenantId,
        sourceType: "payment_intent",
        sourceId: input.intentId,
        direction: "CREDIT",
        account: { in: REFUNDED_ACCOUNTS },
      },
      select: { account: true, amount: true },
    });
    if (credits.length === 0) return { settled: false };

    // A capture's net may already have been paid out (an AVAILABLE debit). Keep
    // the AVAILABLE liability non-negative; a refund after payout needs manual
    // reconciliation instead of silently over-drawing.
    const availableBalance = await accountBalanceCents(tx, tenantId, "AVAILABLE");
    const netCredit = credits.find((c) => c.account === "AVAILABLE");
    const netCents = netCredit ? madToCentimes(netCredit.amount) : 0;
    if (netCents > availableBalance) {
      throw new AppError(
        409,
        "REFUND_AFTER_PAYOUT",
        "Refund would over-draw AVAILABLE — funds already paid out; reconcile manually.",
      );
    }

    const meta = { sourceType: "refund", sourceId: input.refundId };
    for (const row of credits) {
      const cents = madToCentimes(row.amount);
      if (cents <= 0) continue;
      await postEntry(
        tenantId,
        posting(
          debit(row.account, centimes(cents), "REFUND"),
          credit("CASH", centimes(cents), "REFUND"),
          meta,
        ),
        tx,
      );
    }

    return { settled: true };
  });
}
