/**
 * Capture settlement persistence — the ledger write for a successful capture.
 *
 * `settleCapture` posts the canonical capture settlement (gross into COLLECTED,
 * then fee → FEES, reserve → RESERVE, net → AVAILABLE) as a single transaction,
 * idempotently. It is the single entry point that funds a tenant's `AVAILABLE`
 * balance for **card** captures, closing the gap the wallet path (`wallet-db.ts`)
 * already covered for stored-value payments.
 *
 * Idempotency: guarded by the gross `COLLECTED` credit (sourceType
 * `payment_intent` + the intent id). A replayed webhook or a concurrent settle
 * sees that row and is a no-op — so out-of-order provider events (e.g. Stripe
 * `checkout.session.completed` + `payment_intent.succeeded` for one intent) can
 * never double-book money.
 *
 * Amounts cross this boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { Prisma } from "@/generated/prisma/client";

import { resolveFeeSpec } from "./fees-db";
import { credit, debit, posting } from "./ledger";
import { postEntry } from "./ledger-db";
import { centimes } from "./money";
import { prisma } from "./prisma";
import { CAPTURE_SOURCE_TYPE, planCaptureSettlement } from "./settlement";
import type { PolicySpec } from "./settlement-policy";
import { DEFAULT_PRESET } from "./settlement-presets";

export interface SettleCaptureInput {
  /** The `PaymentIntent.id` — the idempotency key for the settlement. */
  intentId: string;
  /** Gross capture amount in centimes (from `resolveIntentCharge`). */
  amountCents: number;
  currency?: string | null;
  /** Payment-method key for `PER_METHOD` fee schedules (e.g. "card"). */
  method?: string | null;
}

/**
 * Settle a successful capture. Returns `{ settled: true }` the first time and
 * `{ settled: false }` on any replay (already settled) or a non-positive amount.
 */
export async function settleCapture(
  tenantId: string,
  input: SettleCaptureInput,
): Promise<{ settled: boolean }> {
  const gross = centimes(Math.round(input.amountCents));
  if (gross <= 0) return { settled: false };

  return prisma.$transaction(async (tx) => {
    const alreadySettled = await tx.ledgerEntry.findFirst({
      where: {
        tenantId,
        sourceType: CAPTURE_SOURCE_TYPE,
        sourceId: input.intentId,
        category: "CAPTURE",
        account: "COLLECTED",
        direction: "CREDIT",
      },
      select: { id: true },
    });
    if (alreadySettled) return { settled: false };

    const feeRow = await tx.feeSchedule.findFirst({ where: { tenantId, isActive: true } });
    const policyRow = await tx.settlementPolicy.findFirst({
      where: { tenantId, isActive: true },
    });
    // `resolveFeeSpec` is the single fallback rule for the whole money path:
    // an explicit active FeeSchedule wins, else the tenant's industry preset fee.
    const fee = resolveFeeSpec(feeRow, policyRow?.industry ?? null);
    const policy: PolicySpec = policyRow ?? DEFAULT_PRESET;

    const plan = planCaptureSettlement(gross, fee, policy, input.method ?? undefined);

    const meta = { sourceType: CAPTURE_SOURCE_TYPE, sourceId: input.intentId };

    // 1. Gross into COLLECTED (money enters the pool; now a liability to the tenant).
    await postEntry(
      tenantId,
      posting(debit("CASH", gross, "CAPTURE"), credit("COLLECTED", gross, "CAPTURE"), meta),
      tx,
    );

    // 2. CorpoPay's fee.
    if (plan.feeCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit("COLLECTED", plan.feeCents, "FEE"),
          credit("FEES", plan.feeCents, "FEE"),
          meta,
        ),
        tx,
      );
    }

    // 3. Per-policy reserve hold-back.
    if (plan.reserveCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit("COLLECTED", plan.reserveCents, "CAPTURE"),
          credit("RESERVE", plan.reserveCents, "CAPTURE"),
          meta,
        ),
        tx,
      );
    }

    // 4. The payout-eligible remainder. Skipped when fee + reserve consume the
    //    gross (a flat fee larger than the transaction), which leaves COLLECTED
    //    negative but keeps the ledger balanced.
    if (plan.netCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit("COLLECTED", plan.netCents, "CAPTURE"),
          credit("AVAILABLE", plan.netCents, "CAPTURE"),
          meta,
        ),
        tx,
      );
    }

    return { settled: true };
  });
}
