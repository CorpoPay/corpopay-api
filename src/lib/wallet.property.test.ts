import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { applyMovement, computeBalance, debit, topUp } from "./wallet";

/**
 * Property tests for the stored-value wallet.
 *
 * Invariants that matter for prepaid money:
 *   - the derived balance is a fold of `applyMovement` over signed amounts;
 *   - `computeBalance` of a list equals folding `applyMovement` from zero;
 *   - a top-up + debit of the same amount returns to the original balance;
 *   - balances and signed amounts stay whole integer centimes.
 */

describe("wallet properties", () => {
  it("computeBalance agrees with folding applyMovement from zero", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 200 }),
        (amounts) => {
          const signed = amounts.map(centimes);
          const folded = signed.reduce(
            (balance, amount) => applyMovement(balance, amount),
            centimes(0),
          );
          expect(computeBalance(signed)).toBe(folded);
        },
      ),
    );
  });

  it("applyMovement is invertible", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (balance, amount) => {
          const moved = applyMovement(centimes(balance), centimes(amount));
          const back = applyMovement(moved, centimes(-amount));
          expect(back).toBe(balance);
        },
      ),
    );
  });

  it("top-up then debit of the same amount returns to the original balance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (balance, amount) => {
          const topped = topUp(centimes(balance), centimes(amount));
          const debited = debit(topped.balanceAfterCents, centimes(amount));
          expect(debited.balanceAfterCents).toBe(balance);
        },
      ),
    );
  });

  it("balances and signed amounts stay whole integer centimes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (balance, amount) => {
          const topped = topUp(centimes(balance), centimes(amount));
          const debited = debit(topped.balanceAfterCents, centimes(amount));
          expect(Number.isInteger(topped.balanceAfterCents)).toBe(true);
          expect(Number.isInteger(topped.signedAmountCents)).toBe(true);
          expect(Number.isInteger(debited.signedAmountCents)).toBe(true);
        },
      ),
    );
  });
});
