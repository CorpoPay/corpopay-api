/**
 * Capture settlement plan (PayFac) — pure, centime-exact math.
 *
 * This is the missing "entry point" that turns a successful provider capture
 * into the tenant's settlement ledger. A card capture settles in five balanced
 * legs (each of which is a `LedgerPosting` — see `settlement-db.ts`):
 *
 *   gross   CASH (debit) → COLLECTED (credit)     money enters the pool, owed gross
 *   fee     COLLECTED → FEES                      CorpoPay's cut
 *   tax     COLLECTED → TAX_PAYABLE               tax on the fee (remitted, not revenue)
 *   reserve COLLECTED → RESERVE                   per-policy hold-back
 *   net     COLLECTED → AVAILABLE                 the tenant's payout-eligible balance
 *
 * The fee comes from the tenant's active `FeeSchedule`; tax from the tenant's
 * `taxRateBps`/`taxExempt`; the reserve from their active `SettlementPolicy`.
 * `net = gross − fee − tax − reserve`. Everything is integer
 * centimes so the double-entry invariant (Σ debits = Σ credits) holds after every
 * leg; the DB stores MAD `Decimal(12,2)` via `money.ts`.
 *
 * This module is pure and side-effect-free (persistence lives in
 * `settlement-db.ts`), so it is unit- and property-testable.
 */
import type { Prisma } from "@/generated/prisma/client";

import { computeFee, type FeeScheduleSpec } from "./fees";
import { type Centimes, type Currency, centimes, toMinor } from "./money";
import { computeReserve, type PolicySpec } from "./settlement-policy";
import { computeTax, type TaxSpec } from "./tax";

/** Ledger `sourceType` used by every capture-settlement posting. */
export const CAPTURE_SOURCE_TYPE = "payment_intent";

export interface CaptureSettlementPlan {
  feeCents: Centimes;
  taxCents: Centimes;
  reserveCents: Centimes;
  netCents: Centimes;
}

/**
 * Plan the capture settlement: `fee + tax + reserve + net = gross` (net may be
 * negative if a flat fee + tax + reserve exceed a tiny gross — the caller's
 * concern, mirroring `netAfterFee`). `method` selects a `PER_METHOD` fee
 * (e.g. "card"); omit for percentage/flat/tiered schedules. `tax` is the
 * tenant's tax config (`taxRateBps` + `taxExempt`); omit for no tax.
 */
export function planCaptureSettlement(
  grossCents: Centimes,
  fee: FeeScheduleSpec,
  policy: PolicySpec,
  method?: string,
  tax?: TaxSpec | null,
): CaptureSettlementPlan {
  const feeCents = computeFee(fee, grossCents, method);
  const taxCents = computeTax(feeCents, tax);
  const reserveCents = computeReserve(policy, grossCents);
  return {
    feeCents,
    taxCents,
    reserveCents,
    netCents: centimes(grossCents - feeCents - taxCents - reserveCents),
  };
}

/** Minimal intent shape needed to resolve a charge amount + currency. */
export interface IntentChargeSource {
  paymentLink: { amount: Prisma.Decimal | number | string; currency: string } | null;
  metadata: unknown;
}

/**
 * Resolve the gross charge amount (centimes) + currency for an intent.
 *
 * A `PaymentLink.amount` is MAD `Decimal(12,2)` → convert via `madToCentimes`.
 * A direct intent (no link) carries its amount already in centimes in
 * `metadata.amount` — never double-multiply (the money invariant).
 */
export function resolveIntentCharge(intent: IntentChargeSource): {
  amountCents: number;
  currency: Currency;
} {
  const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
  const currency: Currency =
    (intent.paymentLink?.currency as Currency | undefined) ??
    (metadata.currency as Currency | undefined) ??
    "MAD";
  const amountCents = intent.paymentLink
    ? Number(toMinor(intent.paymentLink.amount, currency))
    : Number((metadata.amount as number | undefined) ?? 0);
  return { amountCents, currency };
}
