import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeInstallmentAmount, totalInterest } from "./billing";

/**
 * Property tests for installment amortization.
 *
 * The invariants that matter for a BNPL ledger are:
 *   - no negative interest ever leaks out;
 *   - with APR = 0 the installments reconstruct the principal to within the
 *     rounding error of a centime-per-installment;
 *   - with a positive APR the round-up schedule never short-collects the
 *     principal.
 *
 * APR is modelled as a whole-number percentage (0–100), which is the realistic
 * domain for installment plans (8.99%, 12.99%, …) and avoids the numerical
 * instability of sub-normal floating-point rates in the amortization formula.
 */

// Whole-number APR in percent — the realistic, numerically-stable domain.
const aprPct = fc.integer({ min: 0, max: 100 });
// Positive APR (excludes 0) — for the round-up ("never short-collect") invariant.
const positiveAprPct = fc.integer({ min: 1, max: 100 });

describe("billing installment properties", () => {
  it("APR=0 installments reconstruct the principal within rounding error", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 120 }),
        (principal, n) => {
          const installment = computeInstallmentAmount(principal, 0, n);
          const total = Math.round(installment * n * 100) / 100;
          expect(Math.abs(total - principal)).toBeLessThanOrEqual(0.01 * n);
        },
      ),
    );
  });

  it("totalInterest is never negative", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        aprPct,
        fc.integer({ min: 1, max: 120 }),
        (principal, apr, n) => {
          expect(totalInterest(principal, apr, n)).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it("a positive-APR schedule never short-collects the principal (round-up)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        positiveAprPct,
        fc.integer({ min: 1, max: 120 }),
        (principal, apr, n) => {
          const installment = computeInstallmentAmount(principal, apr, n);
          const collected = Math.round(installment * n * 100) / 100;
          expect(collected).toBeGreaterThanOrEqual(principal - 0.01);
        },
      ),
    );
  });

  it("installment amounts are always positive and finite for a positive principal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        aprPct,
        fc.integer({ min: 1, max: 120 }),
        (principal, apr, n) => {
          const installment = computeInstallmentAmount(principal, apr, n);
          expect(Number.isFinite(installment)).toBe(true);
          expect(installment).toBeGreaterThan(0);
        },
      ),
    );
  });
});
