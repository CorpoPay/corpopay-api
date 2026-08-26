import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { canTransition, eligibleAmount, meetsThreshold, PAYOUT_STATUSES } from "./payout";

/**
 * Property tests for the payout eligibility + threshold math.
 *
 * The invariants that matter for settlement:
 *   - eligible never goes negative and never exceeds available;
 *   - eligible equals `available − scheduled` exactly when scheduled ≤ available;
 *   - `meetsThreshold` is a pure `>=` gate (and a strict `> 0` gate when no
 *     threshold is set);
 *   - the status state machine never leaves a terminal state.
 */

const nonNegativeCents = fc.integer({ min: 0, max: 1_000_000_000 }).map((n) => centimes(n));

describe("payout properties", () => {
  it("eligibleAmount is always between 0 and available", () => {
    fc.assert(
      fc.property(nonNegativeCents, nonNegativeCents, (available, scheduled) => {
        const eligible = eligibleAmount(available, scheduled);
        expect(eligible).toBeGreaterThanOrEqual(0);
        expect(eligible).toBeLessThanOrEqual(available);
      }),
    );
  });

  it("eligibleAmount equals available − scheduled when scheduled ≤ available", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.integer({ min: 0, max: 1_000_000_000 }),
            fc.integer({ min: 0, max: 1_000_000_000 }),
          )
          .filter(([a, s]) => s <= a),
        ([available, scheduled]) => {
          expect(eligibleAmount(centimes(available), centimes(scheduled))).toBe(
            available - scheduled,
          );
        },
      ),
    );
  });

  it("meetsThreshold with a null threshold is a strict positivity gate", () => {
    fc.assert(
      fc.property(nonNegativeCents, (eligible) => {
        expect(meetsThreshold(eligible, null)).toBe(eligible > 0);
      }),
    );
  });

  it("meetsThreshold with a threshold is a pure >= gate", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 1_000_000_000 }),
          fc.integer({ min: 0, max: 1_000_000_000 }),
        ),
        ([eligible, threshold]) => {
          expect(meetsThreshold(centimes(eligible), centimes(threshold))).toBe(
            eligible >= threshold,
          );
        },
      ),
    );
  });

  it("terminal statuses never have an outgoing transition", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(["PAID", "FAILED", "CANCELLED"] as const)),
        fc.constantFrom(...PAYOUT_STATUSES),
        (from, to) => {
          expect(canTransition(from, to)).toBe(false);
        },
      ),
    );
  });
});
