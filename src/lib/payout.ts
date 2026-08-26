/**
 * Payout engine (PayFac settlement) — pure, centime-exact math.
 *
 * A `Payout` moves money from the tenant's `AVAILABLE` ledger balance to
 * `PAID_OUT`. This module holds the pure decision logic:
 *
 *   - the payout status state machine (draft → scheduled → pending → processing
 *     → paid, with failed / cancelled terminal branches);
 *   - eligibility math: how much is payable (available minus already-scheduled),
 *     and whether a threshold / manual trigger is met.
 *
 * Persistence + the ledger posting (`payout-db.ts`) wraps these helpers.
 * Amounts cross this module's boundary as integer centimes.
 */
import type { PayoutStatus } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

export const PAYOUT_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "PENDING",
  "PROCESSING",
  "PAID",
  "FAILED",
  "CANCELLED",
] as const;

/** Allowed outgoing transitions for each payout status (terminal states have none). */
const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["PENDING", "CANCELLED"],
  PENDING: ["PROCESSING", "FAILED", "CANCELLED"],
  PROCESSING: ["PAID", "FAILED"],
  PAID: [],
  FAILED: [],
  CANCELLED: [],
};

export class PayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutError";
  }
}

/** Whether `to` is a legal next state from `from`. */
export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Assert a transition is legal, throwing `PayoutError` otherwise. */
export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransition(from, to)) {
    throw new PayoutError(`illegal payout transition ${from} -> ${to}`);
  }
}

/**
 * The amount actually payable: `available − already-scheduled`, floored at zero.
 * `already-scheduled` covers any DRAFT/SCHEDULED payouts that have already
 * reserved funds, so we never double-count.
 */
export function eligibleAmount(
  availableCents: Centimes,
  alreadyScheduledCents: Centimes,
): Centimes {
  return centimes(Math.max(0, availableCents - alreadyScheduledCents));
}

/**
 * Whether a payout should fire for a given schedule.
 *   - `thresholdCents == null` → manual/immediate: pay whenever anything is available.
 *   - `thresholdCents != null` → only when eligible reaches the threshold.
 */
export function meetsThreshold(eligibleCents: Centimes, thresholdCents: Centimes | null): boolean {
  if (thresholdCents == null) return eligibleCents > 0;
  return eligibleCents >= thresholdCents;
}
