/**
 * Capture settlement plan (PayFac) — pure, centime-exact math.
 *
 * This is the missing "entry point" that turns a successful provider capture
 * into the tenant's settlement ledger. A card capture settles in four balanced
 * legs (each of which is a `LedgerPosting` — see `settlement-db.ts`):
 *
 *   gross   CASH (debit) → COLLECTED (credit)     money enters the pool, owed gross
 *   fee     COLLECTED → FEES                      CorpoPay's cut
 *   reserve COLLECTED → RESERVE                   per-policy hold-back
 *   net     COLLECTED → AVAILABLE                 the tenant's payout-eligible balance
 *
 * The fee comes from the tenant's active `FeeSchedule`; the reserve from their
 * active `SettlementPolicy`. `net = gross − fee − reserve`. Everything is integer
 * centimes so the double-entry invariant (Σ debits = Σ credits) holds after every
 * leg; the DB stores MAD `Decimal(12,2)` via `money.ts`.
 *
 * This module is pure and side-effect-free (persistence lives in
 * `settlement-db.ts`), so it is unit- and property-testable.
 */
import type { Prisma } from "@/generated/prisma/client";

import { computeFee, type FeeScheduleSpec } from "./fees";
import { type Centimes, centimes, madToCentimes } from "./money";
import { computeReserve, type PolicySpec } from "./settlement-policy";

/** Ledger `sourceType` used by every capture-settlement posting. */
export const CAPTURE_SOURCE_TYPE = "payment_intent";

export interface CaptureSettlementPlan {
  feeCents: Centimes;
  reserveCents: Centimes;
  netCents: Centimes;
}

/**
 * Plan the capture settlement: `fee + reserve + net = gross` (net may be negative
 * if a flat fee + reserve exceed a tiny gross — the caller's concern, mirroring
 * `netAfterFee`). `method` selects a `PER_METHOD` fee (e.g. "card"); omit for
 * percentage/flat/tiered schedules.
 */
export function planCaptureSettlement(
  grossCents: Centimes,
  fee: FeeScheduleSpec,
  policy: PolicySpec,
  method?: string,
): CaptureSettlementPlan {
  const feeCents = computeFee(fee, grossCents, method);
  const reserveCents = computeReserve(policy, grossCents);
  return {
    feeCents,
    reserveCents,
    netCents: centimes(grossCents - feeCents - reserveCents),
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
  currency: string;
} {
  const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
  const amountCents = intent.paymentLink
    ? Number(madToCentimes(intent.paymentLink.amount))
    : Number((metadata.amount as number | undefined) ?? 0);
  const currency =
    intent.paymentLink?.currency ?? (metadata.currency as string | undefined) ?? "MAD";
  return { amountCents, currency };
}
