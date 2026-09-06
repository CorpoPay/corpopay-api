import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { evaluateRisk, MemoryVelocityStore, Velocity } from "./risk";

/**
 * Property tests for the risk engine.
 *
 * The invariants that keep risk detection trustworthy:
 *   - BLOCK is decided *only* by the amount threshold (strictly above);
 *   - the reasons array is an exact function of the verdict (never empty on a
 *     non-allow verdict, never populated on allow);
 *   - score always equals the prior in-window event count;
 *   - the sliding window prunes to the centisecond-exact cutoff (>= kept, < dropped).
 */

const amountCents = fc.integer({ min: 0, max: 2_000_000 }).map(centimes);
const velocityCount = fc.integer({ min: 0, max: 10_000 });
const thresholds = { maxAmountCents: centimes(1000), maxPerWindow: 3 };

describe("risk properties", () => {
  it("verdict is BLOCK iff the amount exceeds the threshold", () => {
    fc.assert(
      fc.property(amountCents, velocityCount, (amount, count) => {
        const r = evaluateRisk(amount, count, thresholds);
        expect(r.verdict === "BLOCK").toBe(amount > thresholds.maxAmountCents);
      }),
    );
  });

  it("reasons match the verdict exactly", () => {
    fc.assert(
      fc.property(amountCents, velocityCount, (amount, count) => {
        const r = evaluateRisk(amount, count, thresholds);
        if (r.verdict === "BLOCK") expect(r.reasons).toEqual(["amount_exceeds_threshold"]);
        else if (r.verdict === "REVIEW") expect(r.reasons).toEqual(["velocity_exceeds_threshold"]);
        else expect(r.reasons).toEqual([]);
      }),
    );
  });

  it("score always equals the prior count", () => {
    fc.assert(
      fc.property(amountCents, velocityCount, (amount, count) => {
        expect(evaluateRisk(amount, count).score).toBe(count);
      }),
    );
  });

  it("sliding window prunes to the exact cutoff", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 120_000 }), { minLength: 0, maxLength: 50 }),
        (offsets) => {
          const v = new Velocity(new MemoryVelocityStore(), 60);
          const base = new Date(1_000_000).getTime();
          const now = base + 120_000;
          for (const off of offsets) v.record("t", new Date(base + off));
          const expected = offsets.filter((off) => base + off >= now - 60_000).length;
          expect(v.count("t", new Date(now))).toBe(expected);
        },
      ),
    );
  });
});
