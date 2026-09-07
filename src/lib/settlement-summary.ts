/**
 * Settlement summary (Tier 2) — pure, centime-exact math.
 *
 * The single number a CorpoPay admin needs to settle a tenant: how much is owed
 * after commission, fees, reserve and reversals. Derived entirely from the
 * ledger account balances (see `ledger.ts`) plus the amount already reserved by
 * open payouts:
 *
 *   netOwed   = AVAILABLE balance   (gross − fee − reserve − already paid out)
 *   eligible  = AVAILABLE − open payouts (what can be scheduled right now)
 *
 * `fees` / `reserve` / `paidOut` are surfaced alongside so the admin sees the
 * full "how we got here" breakdown for a manual (Morocco) payout. Amounts cross
 * this module's boundary as integer centimes; the DB stores MAD `Decimal(12,2)`.
 */
import type { LedgerAccount } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

export interface SettlementSummary {
  /** Net owed: the payout-eligible balance (`AVAILABLE`). */
  availableCents: Centimes;
  /** Funds already reserved by open (non-terminal) payouts. */
  scheduledCents: Centimes;
  /** `available − scheduled`, floored at zero — what can be paid right now. */
  eligibleCents: Centimes;
  /** CorpoPay revenue to date (`FEES`). */
  feesCents: Centimes;
  /** Held back against reversals (`RESERVE`). */
  reserveCents: Centimes;
  /** Cumulative amount already settled (`PAID_OUT`). */
  paidOutCents: Centimes;
}

/** Compute the settlement summary from account balances + open-payout reserve. */
export function computeSettlementSummary(
  balances: Partial<Record<LedgerAccount, Centimes>>,
  scheduledCents: Centimes,
): SettlementSummary {
  const available = balances.AVAILABLE ?? centimes(0);
  const fees = balances.FEES ?? centimes(0);
  const reserve = balances.RESERVE ?? centimes(0);
  const paidOut = balances.PAID_OUT ?? centimes(0);

  return {
    availableCents: available,
    scheduledCents,
    eligibleCents: centimes(Math.max(0, available - scheduledCents)),
    feesCents: fees,
    reserveCents: reserve,
    paidOutCents: paidOut,
  };
}
