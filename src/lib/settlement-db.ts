import { resolveFeeSpec } from "./fees-db";
import { credit, debit, posting } from "./ledger";
import { postEntry } from "./ledger-db";
import { type Currency, centimes } from "./money";
import { prisma } from "./prisma";
import { CAPTURE_SOURCE_TYPE, planCaptureSettlement } from "./settlement";
import { type PolicySpec, resolvePolicy } from "./settlement-policy";
import { DEFAULT_PRESET } from "./settlement-presets";
import { type ShareSpec, split } from "./splits";
import { executeSplitInTx } from "./splits-db";
import type { TaxSpec } from "./tax";

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
  const currency: Currency = (input.currency as Currency | undefined) ?? "MAD";

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

    // Tax (ADR 0007) comes from the tenant's own config — no global rate.
    const tenantTax = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { taxRateBps: true, taxExempt: true },
    });
    const tax: TaxSpec = {
      taxRateBps: tenantTax?.taxRateBps ?? 0,
      taxExempt: tenantTax?.taxExempt ?? false,
    };

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

    const plan = planCaptureSettlement(planBase, fee, policy, input.method ?? undefined, tax);

    const meta = { sourceType: CAPTURE_SOURCE_TYPE, sourceId: input.intentId };

    // 1. Gross into COLLECTED (money enters the pool; now a liability to the tenant).
    await postEntry(
      tenantId,
      posting(
        debit("CASH", gross, "CAPTURE", null, currency),
        credit("COLLECTED", gross, "CAPTURE", null, currency),
        meta,
      ),
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
          currency,
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
        posting(
          debit(feeFrom, plan.feeCents, "FEE", null, currency),
          credit("FEES", plan.feeCents, "FEE", null, currency),
          meta,
        ),
        tx,
      );
    }

    // 4. Tax on the fee (exclusive) — same source as the fee, a TAX_PAYABLE liability.
    if (plan.taxCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit(feeFrom, plan.taxCents, "TAX", null, currency),
          credit("TAX_PAYABLE", plan.taxCents, "TAX", null, currency),
          meta,
        ),
        tx,
      );
    }

    // 5. Per-policy reserve hold-back.
    if (plan.reserveCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit(feeFrom, plan.reserveCents, "CAPTURE", null, currency),
          credit("RESERVE", plan.reserveCents, "CAPTURE", null, currency),
          meta,
        ),
        tx,
      );
    }

    // 6. The payout-eligible remainder (non-split only; the split already moved the
    //    platform remainder to AVAILABLE and fee/reserve were carved from it).
    if (!rule && plan.netCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit("COLLECTED", plan.netCents, "CAPTURE", null, currency),
          credit("AVAILABLE", plan.netCents, "CAPTURE", null, currency),
          meta,
        ),
        tx,
      );
    }

    return { settled: true };
  });
}
