import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyPosting,
  computeBalances,
  computeBalancesByCurrency,
  credit,
  debit,
  isBalanced,
  LEDGER_CATEGORIES,
  type LedgerAccount,
  posting,
  zeroBalances,
} from "./ledger";
import { type Currency, centimes, SUPPORTED_CURRENCIES } from "./money";

/**
 * Property tests for the double-entry ledger.
 *
 * The invariants that matter most for a settlement ledger:
 *   - every posting balances, and any sequence of them keeps Σ debits = Σ credits;
 *   - derived balances agree with folding `applyPosting` from zero;
 *   - the fundamental equation holds: the sum of all account balances is zero;
 *   - balances stay whole minor units (no fractional minor unit is ever invented);
 *   - multi-currency: balancing and zero-sum hold *within* each currency.
 */

const accountPairs: [LedgerAccount, LedgerAccount][] = [
  ["CASH", "COLLECTED"],
  ["PENDING", "COLLECTED"],
  ["COLLECTED", "AVAILABLE"],
  ["AVAILABLE", "RESERVE"],
  ["COLLECTED", "FEES"],
  ["AVAILABLE", "CASH"],
  ["COLLECTED", "CASH"],
];

const postingArb = fc
  .tuple(
    fc.constantFrom(...accountPairs),
    fc.integer({ min: 0, max: 1_000_000_000 }),
    fc.constantFrom(...LEDGER_CATEGORIES),
  )
  .map(([pair, amount, category]) =>
    posting(
      debit(pair[0], centimes(amount), category),
      credit(pair[1], centimes(amount), category),
    ),
  );

describe("ledger properties", () => {
  it("a sequence of balanced postings is always balanced", () => {
    fc.assert(
      fc.property(fc.array(postingArb, { maxLength: 200 }), (postings) => {
        const legs = postings.flatMap((p) => [p.debit, p.credit]);
        expect(isBalanced(legs)).toBe(true);
      }),
    );
  });

  it("computeBalances agrees with folding applyPosting from zero", () => {
    fc.assert(
      fc.property(fc.array(postingArb, { maxLength: 200 }), (postings) => {
        const legs = postings.flatMap((p) => [p.debit, p.credit]);
        const folded = postings.reduce(applyPosting, zeroBalances());
        expect(computeBalances(legs)).toEqual(folded);
      }),
    );
  });

  it("the sum of all account balances is always zero", () => {
    fc.assert(
      fc.property(fc.array(postingArb, { maxLength: 200 }), (postings) => {
        const balances = postings.reduce(applyPosting, zeroBalances());
        const total = Object.values(balances).reduce((a, b) => a + b, 0);
        expect(total).toBe(0);
      }),
    );
  });

  it("every account balance stays a whole integer minor unit", () => {
    fc.assert(
      fc.property(fc.array(postingArb, { maxLength: 200 }), (postings) => {
        const balances = postings.reduce(applyPosting, zeroBalances());
        for (const balance of Object.values(balances)) {
          expect(Number.isInteger(balance)).toBe(true);
        }
      }),
    );
  });
});

describe("multi-currency ledger properties", () => {
  const currencyArb = fc.constantFrom<Currency>(...SUPPORTED_CURRENCIES);

  const mixedPostingArb = fc
    .tuple(
      fc.constantFrom(...accountPairs),
      fc.integer({ min: 0, max: 1_000_000_000 }),
      fc.constantFrom(...LEDGER_CATEGORIES),
      currencyArb,
    )
    .map(([pair, amount, category, currency]) =>
      posting(
        debit(pair[0], centimes(amount), category, null, currency),
        credit(pair[1], centimes(amount), category, null, currency),
      ),
    );

  it("a sequence of single-currency postings is always per-currency balanced", () => {
    fc.assert(
      fc.property(fc.array(mixedPostingArb, { maxLength: 200 }), (postings) => {
        const legs = postings.flatMap((p) => [p.debit, p.credit]);
        expect(isBalanced(legs)).toBe(true);
      }),
    );
  });

  it("per-currency balances sum to zero within each currency", () => {
    fc.assert(
      fc.property(fc.array(mixedPostingArb, { maxLength: 200 }), (postings) => {
        const legs = postings.flatMap((p) => [p.debit, p.credit]);
        const byCurrency = computeBalancesByCurrency(legs);
        for (const balances of Object.values(byCurrency)) {
          const total = Object.values(balances).reduce((a, b) => a + b, 0);
          expect(total).toBe(0);
        }
      }),
    );
  });
});
