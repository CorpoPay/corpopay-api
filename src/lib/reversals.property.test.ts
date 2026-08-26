import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { coveredAmount, fundReversal } from "./reversals";

/**
 * Property tests for the reversal funding allocation.
 *
 * The invariants that matter for a clawback:
 *   - the allocation is total-preserving (fromAvailable + fromReserve + uncovered
 *     always equals the gross) across every strategy;
 *   - no leg is ever negative;
 *   - for non-ALLOW_NEGATIVE strategies, available and reserve legs never exceed
 *     their source balances.
 */

const nonNegative = fc.integer({ min: 0, max: 1_000_000_000 }).map((n) => centimes(n));
const strategies = fc.constantFrom(
  "NET_FROM_AVAILABLE",
  "DEBIT_RESERVE",
  "INVOICE_TENANT",
  "ALLOW_NEGATIVE",
);

describe("reversal funding properties", () => {
  it("the allocation always sums to the gross", () => {
    fc.assert(
      fc.property(
        strategies,
        nonNegative,
        nonNegative,
        nonNegative,
        (strategy, gross, available, reserve) => {
          const alloc = fundReversal(
            { reversalFunding: strategy, allowNegative: strategy === "ALLOW_NEGATIVE" },
            gross,
            available,
            reserve,
          );
          expect(alloc.fromAvailable + alloc.fromReserve + alloc.uncovered).toBe(gross);
        },
      ),
    );
  });

  it("no leg is ever negative", () => {
    fc.assert(
      fc.property(
        strategies,
        nonNegative,
        nonNegative,
        nonNegative,
        (strategy, gross, available, reserve) => {
          const alloc = fundReversal(
            { reversalFunding: strategy, allowNegative: strategy === "ALLOW_NEGATIVE" },
            gross,
            available,
            reserve,
          );
          expect(alloc.fromAvailable).toBeGreaterThanOrEqual(0);
          expect(alloc.fromReserve).toBeGreaterThanOrEqual(0);
          expect(alloc.uncovered).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it("non-negative strategies never exceed their source balances", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("NET_FROM_AVAILABLE", "DEBIT_RESERVE", "INVOICE_TENANT"),
        nonNegative,
        nonNegative,
        nonNegative,
        (strategy, gross, available, reserve) => {
          const alloc = fundReversal(
            { reversalFunding: strategy, allowNegative: false },
            gross,
            available,
            reserve,
          );
          expect(alloc.fromAvailable).toBeLessThanOrEqual(available);
          expect(alloc.fromReserve).toBeLessThanOrEqual(reserve);
        },
      ),
    );
  });

  it("coveredAmount + uncovered equals the gross", () => {
    fc.assert(
      fc.property(
        strategies,
        nonNegative,
        nonNegative,
        nonNegative,
        (strategy, gross, available, reserve) => {
          const alloc = fundReversal(
            { reversalFunding: strategy, allowNegative: strategy === "ALLOW_NEGATIVE" },
            gross,
            available,
            reserve,
          );
          expect(coveredAmount(alloc) + alloc.uncovered).toBe(gross);
        },
      ),
    );
  });
});
