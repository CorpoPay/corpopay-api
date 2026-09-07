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
import { type PolicySpec, resolvePolicy } from "./settlement-policy";
import { DEFAULT_PRESET } from "./settlement-presets";
import { type ShareSpec, split } from "./splits";
import { executeSplitInTx } from "./splits-db";

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
    const policy: PolicySpec = policyRow ?? resolvePolicy(DEFAULT_PRESET);

    // A marketplace tenant (splittingEnabled) with an active AT_CAPTURE rule splits
    // the GROSS; the platform fee + reserve are then computed on the platform
    // remainder so beneficiary shares are never reduced.
    const rule = policy.splittingEnabled
      ? await tx.splitRule.findFirst({
          where: { tenantId, isActive: true, trigger: "AT_CAPTURE" },
          orderBy: { createdAt: "asc" },
        })
      : null;
    const shares = rule ? (rule.shares as unknown as ShareSpec[]) : [];
    const planBase = rule ? split(gross, shares).platformCents : gross;

    const plan = planCaptureSettlement(planBase, fee, policy, input.method ?? undefined);

    const meta = { sourceType: CAPTURE_SOURCE_TYPE, sourceId: input.intentId };

    // 1. Gross into COLLECTED (money enters the pool; now a liability to the tenant).
    await postEntry(
      tenantId,
      posting(debit("CASH", gross, "CAPTURE"), credit("COLLECTED", gross, "CAPTURE"), meta),
      tx,
    );

    if (rule) {
      // 2. Split the gross among beneficiaries + platform remainder (drains COLLECTED;
      //    fee + reserve are then funded from AVAILABLE — the platform's own cut).
      await executeSplitInTx(
        tx,
        tenantId,
        {
          sourceType: CAPTURE_SOURCE_TYPE,
          sourceId: input.intentId,
          sourceCents: gross,
          splitRuleId: rule.id,
        },
        "AT_CAPTURE",
        shares,
      );
    }

    // 3. CorpoPay's fee — from COLLECTED (non-split) or the platform remainder (split).
    const feeFrom = rule ? "AVAILABLE" : "COLLECTED";
    if (plan.feeCents > 0) {
      await postEntry(
        tenantId,
        posting(debit(feeFrom, plan.feeCents, "FEE"), credit("FEES", plan.feeCents, "FEE"), meta),
        tx,
      );
    }

    // 4. Per-policy reserve hold-back.
    if (plan.reserveCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit(feeFrom, plan.reserveCents, "CAPTURE"),
          credit("RESERVE", plan.reserveCents, "CAPTURE"),
          meta,
        ),
        tx,
      );
    }

    // 5. The payout-eligible remainder (non-split only; the split already moved the
    //    platform remainder to AVAILABLE and fee/reserve were carved from it).
    if (!rule && plan.netCents > 0) {
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
