/**
 * Reversal engine (PayFac) — pure, centime-exact math.
 *
 * A reversal (a lost chargeback/dispute) claws money back from a tenant after
 * the provider has already taken the gross amount out of CorpoPay's pool. Where
 * that clawback comes from is the tenant's `reversalFunding` policy:
 *
 *   NET_FROM_AVAILABLE — net it from the tenant's AVAILABLE balance (any
 *     shortfall becomes a `Recovery` receivable).
 *   DEBIT_RESERVE      — draw the reserve down first, then AVAILABLE, then a
 *     `Recovery`.
 *   INVOICE_TENANT     — don't touch ledger balances; the full amount is a
 *     `Recovery` (CorpoPay invoices the tenant).
 *   ALLOW_NEGATIVE     — debit AVAILABLE for the full amount, allowing it to go
 *     negative (the disbursement-first / lending posture).
 *
 * This module holds the pure decision logic (status state machine + the funding
 * allocation). Persistence + the ledger posting live in `reversals-db.ts`.
 * Amounts cross this boundary as integer centimes.
 */
import type { DisputeStatus, ReversalFundingPolicy } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

export const DISPUTE_STATUSES = ["OPEN", "WON", "LOST"] as const;

/** Allowed outgoing transitions for each dispute status (terminal states have none). */
const TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  OPEN: ["WON", "LOST"],
  WON: [],
  LOST: [],
};

export class ReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReversalError";
  }
}

/** Whether `to` is a legal next state from `from`. */
export function canTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Assert a transition is legal, throwing `ReversalError` otherwise. */
export function assertTransition(from: DisputeStatus, to: DisputeStatus): void {
  if (!canTransition(from, to)) {
    throw new ReversalError(`illegal dispute transition ${from} -> ${to}`);
  }
}

/**
 * How a reversal of `grossCents` is funded, given the tenant's current AVAILABLE
 * and RESERVE balances. The three legs always sum to the gross amount.
 */
export interface ClawbackAllocation {
  /** Debited from AVAILABLE (may exceed the balance only under ALLOW_NEGATIVE). */
  fromAvailable: Centimes;
  /** Debited from RESERVE (only under DEBIT_RESERVE). */
  fromReserve: Centimes;
  /** Not immediately recoverable — becomes a `Recovery` receivable. */
  uncovered: Centimes;
}

/**
 * Decide where a reversal is funded from. Pure and total-preserving: the sum of
 * the three legs always equals `grossCents`.
 */
export function fundReversal(
  policy: { reversalFunding: ReversalFundingPolicy; allowNegative: boolean },
  grossCents: Centimes,
  availableCents: Centimes,
  reserveCents: Centimes,
): ClawbackAllocation {
  if (grossCents < 0) throw new ReversalError("gross must be non-negative");
  if (availableCents < 0) throw new ReversalError("available balance must be non-negative");
  if (reserveCents < 0) throw new ReversalError("reserve balance must be non-negative");

  switch (policy.reversalFunding) {
    case "NET_FROM_AVAILABLE": {
      const fromAvailable = centimes(Math.min(grossCents, availableCents));
      return {
        fromAvailable,
        fromReserve: centimes(0),
        uncovered: centimes(grossCents - fromAvailable),
      };
    }

    case "DEBIT_RESERVE": {
      const fromReserve = centimes(Math.min(grossCents, reserveCents));
      const remaining = grossCents - fromReserve;
      const fromAvailable = centimes(Math.min(remaining, availableCents));
      return {
        fromAvailable,
        fromReserve,
        uncovered: centimes(remaining - fromAvailable),
      };
    }

    case "INVOICE_TENANT":
      return {
        fromAvailable: centimes(0),
        fromReserve: centimes(0),
        uncovered: grossCents,
      };

    case "ALLOW_NEGATIVE":
      // Debit AVAILABLE for the full gross, letting it go negative.
      return {
        fromAvailable: grossCents,
        fromReserve: centimes(0),
        uncovered: centimes(0),
      };
  }
}

/** Total covered immediately (reserve + available); `gross - covered` = uncovered. */
export function coveredAmount(allocation: ClawbackAllocation): Centimes {
  return centimes(allocation.fromAvailable + allocation.fromReserve);
}
