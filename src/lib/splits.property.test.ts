import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { computeShares, type ShareSpec, split } from "./splits";

/**
 * Property tests for split math.
 *
 * Invariants that make the split engine safe to ship:
 *   - `split` is total-preserving: beneficiary shares + platform remainder always
 *     equal the source (no centime is created or lost);
 *   - every share and the platform remainder are non-negative;
 *   - `computeShares` divides its total exactly (Σ = total) and keeps every
 *     beneficiary within one centime of its ideal.
 */

const source = fc.integer({ min: 0, max: 1_000_000_000 }).map((n) => centimes(n));

const shareLists: fc.Arbitrary<ShareSpec[]> = fc.oneof(
  fc.integer({ min: 1, max: 10_000 }).map((shareBps) => [{ partyId: "p1", shareBps }]),
  fc.tuple(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 1, max: 5_000 })).map(([a, b]) => [
    { partyId: "p1", shareBps: a },
    { partyId: "p2", shareBps: b },
  ]),
);

describe("split properties", () => {
  it("always totals the source (beneficiaries + platform)", () => {
    fc.assert(
      fc.property(source, shareLists, (src, shares) => {
        const result = split(src, shares);
        const total =
          result.shares.reduce((sum, a) => sum + a.amountCents, 0) + result.platformCents;
        expect(total).toBe(src);
      }),
    );
  });

  it("never produces a negative share or platform remainder", () => {
    fc.assert(
      fc.property(source, shareLists, (src, shares) => {
        const result = split(src, shares);
        for (const allocation of result.shares) {
          expect(allocation.amountCents).toBeGreaterThanOrEqual(0);
        }
        expect(result.platformCents).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("computeShares divides its total exactly", () => {
    fc.assert(
      fc.property(source, shareLists, (total, shares) => {
        const allocations = computeShares(total, shares);
        expect(allocations.reduce((sum, a) => sum + a.amountCents, 0)).toBe(total);
      }),
    );
  });

  it("each computeShares allocation is within one centime of its ideal", () => {
    fc.assert(
      fc.property(source, shareLists, (total, shares) => {
        const totalBps = shares.reduce((sum, s) => sum + s.shareBps, 0);
        const byParty = new Map(
          computeShares(total, shares).map((a) => [a.partyId, a.amountCents]),
        );
        for (const share of shares) {
          const ideal = (total * share.shareBps) / totalBps;
          const actual = byParty.get(share.partyId) as number;
          expect(Math.abs(actual - ideal)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});
