/**
 * FX settlement plan (ADR 0006, phase 4) — pure, centime-exact math.
 *
 * When a tenant's `AVAILABLE` balance holds a currency different from their
 * `settlementCurrency`, that balance must be converted before payout. This module
 * plans the conversion and the explicit `FX_ADJUSTMENT` posting that records the
 * gain/loss.
 *
 * The tenant is owed the amount converted at the **locked** rate (quoted before
 * they acted). CorpoPay's treasury may obtain a different **reference** rate; the
 * delta is CorpoPay's FX P&L and is posted to `FEES` under the `FX_ADJUSTMENT`
 * category so it is auditable — never hidden in rounding.
 *
 * A conversion is three balanced, single-currency postings (money never mixes
 * currencies in one posting):
 *
 *   1. Remove the source `AVAILABLE` (debit AVAILABLE, credit CASH — `from`).
 *   2. Add the settlement `AVAILABLE` at the locked rate (debit CASH, credit
 *      AVAILABLE — `to`).
 *   3. `FX_ADJUSTMENT` — the reference-vs-locked delta in `to`:
 *        gain > 0 → debit CASH, credit FEES (CorpoPay FX income)
 *        gain < 0 → debit FEES, credit CASH (CorpoPay FX expense)
 *
 * Persistence + the tenant balance read live in `fx-settlement-db.ts`.
 */

import { convertMinor, formatRate } from "./fx";
import { credit, debit, type LedgerPosting, posting } from "./ledger";
import { type Centimes, type Currency, centimes } from "./money";

/** Ledger `sourceType` for the conversion legs. */
export const FX_CONVERSION_SOURCE_TYPE = "fx_conversion";
/** Ledger `sourceType` for the gain/loss posting. */
export const FX_ADJUSTMENT_SOURCE_TYPE = "fx_adjustment";

export interface PlanFxConversionInput {
  from: Currency;
  to: Currency;
  /** The full foreign `AVAILABLE` balance being converted (minor units of `from`). */
  amountFromMinor: Centimes;
  /** The locked rate (`1 from = lockedRate to`). */
  lockedRate: string | number;
  /** The reference rate CorpoPay actually obtains (`1 from = referenceRate to`). */
  referenceRate: string | number;
}

export interface FxConversionPlan {
  from: Currency;
  to: Currency;
  amountFromMinor: Centimes;
  /** Converted amount in `to` minor units, at the locked rate (what the tenant gets). */
  amountToMinor: Centimes;
  /** Signed FX P&L in `to` minor units: `reference − locked` (positive = CorpoPay gains). */
  gainLossMinor: Centimes;
  lockedRate: string;
  referenceRate: string;
  /** The postings to apply, in order. */
  postings: LedgerPosting[];
}

/**
 * Plan a currency conversion. Pure and side-effect-free, so it is unit- and
 * property-testable (see `fx-settlement.property.test.ts`).
 */
export function planFxConversion(input: PlanFxConversionInput): FxConversionPlan {
  const from: Currency = input.from;
  const to: Currency = input.to;
  if (from === to) throw new Error("planFxConversion requires a cross-currency pair");

  const amountFromMinor = centimes(input.amountFromMinor);
  const lockedRate = formatRate(Number(input.lockedRate));
  const referenceRate = formatRate(Number(input.referenceRate));

  const amountToMinor = convertMinor(amountFromMinor, lockedRate);
  const referenceToMinor = convertMinor(amountFromMinor, referenceRate);
  const gainLossMinor = centimes(referenceToMinor - amountToMinor);

  const meta = { sourceType: FX_CONVERSION_SOURCE_TYPE };

  // 1. Drain the foreign AVAILABLE balance (balanced in `from`).
  const drainSource = posting(
    debit("AVAILABLE", amountFromMinor, "ADJUSTMENT", null, from),
    credit("CASH", amountFromMinor, "ADJUSTMENT", null, from),
    meta,
  );

  // 2. Credit the tenant's settlement AVAILABLE at the locked rate (balanced in `to`).
  const creditSettlement = posting(
    debit("CASH", amountToMinor, "ADJUSTMENT", null, to),
    credit("AVAILABLE", amountToMinor, "ADJUSTMENT", null, to),
    meta,
  );

  // 3. The explicit FX gain/loss (balanced in `to`).
  const postings: LedgerPosting[] = [drainSource, creditSettlement];
  if (gainLossMinor > 0) {
    postings.push(
      posting(
        debit("CASH", gainLossMinor, "FX_ADJUSTMENT", null, to),
        credit("FEES", gainLossMinor, "FX_ADJUSTMENT", null, to),
        { sourceType: FX_ADJUSTMENT_SOURCE_TYPE },
      ),
    );
  } else if (gainLossMinor < 0) {
    postings.push(
      posting(
        debit("FEES", centimes(-gainLossMinor), "FX_ADJUSTMENT", null, to),
        credit("CASH", centimes(-gainLossMinor), "FX_ADJUSTMENT", null, to),
        { sourceType: FX_ADJUSTMENT_SOURCE_TYPE },
      ),
    );
  }

  return {
    from,
    to,
    amountFromMinor,
    amountToMinor,
    gainLossMinor,
    lockedRate,
    referenceRate,
    postings,
  };
}
