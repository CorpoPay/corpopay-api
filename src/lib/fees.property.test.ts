import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { FeeType } from "@/generated/prisma/client";

import { applyBps, computeFee, type FeeScheduleSpec, type FeeTier, netAfterFee } from "./fees";
import { centimes } from "./money";

/**
 * Property tests for the fee engine. The invariants that matter for money:
 *   - a fee is always a non-negative whole centime (never a fraction);
 *   - FLAT is amount-independent; PERCENTAGE is monotonic and never exceeds gross
 *     for rates ≤ 100%; TIERED always matches exactly one bracket's rate;
 *   - `netAfterFee` is consistent with `computeFee` (net = gross − fee).
 */

const amountArb = fc.integer({ min: 0, max: 100_000_000 });
const bpsArb = fc.integer({ min: 0, max: 10_000 });

const percentSpecArb = fc
  .record({
    feeType: fc.constant("PERCENTAGE" as FeeType),
    flatCents: fc.constant(null),
    percentageBps: bpsArb,
    perMethodCents: fc.constant(null),
    tiersCents: fc.constant(null),
  })
  .map((s) => s as FeeScheduleSpec);

const flatSpecArb = fc
  .record({
    feeType: fc.constant("FLAT" as FeeType),
    flatCents: fc.integer({ min: 0, max: 100_000 }),
    percentageBps: fc.constant(null),
    perMethodCents: fc.constant(null),
    tiersCents: fc.constant(null),
  })
  .map((s) => s as FeeScheduleSpec);

describe("fee engine invariants", () => {
  it("always returns a non-negative whole centime", () => {
    fc.assert(
      fc.property(percentSpecArb, amountArb, (spec, amount) => {
        const fee = computeFee(spec, centimes(amount));
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("FLAT is independent of the transaction amount", () => {
    fc.assert(
      fc.property(flatSpecArb, amountArb, amountArb, (spec, a, b) => {
        expect(computeFee(spec, centimes(a))).toBe(computeFee(spec, centimes(b)));
      }),
    );
  });

  it("PERCENTAGE is monotonic and never exceeds gross for rates ≤ 100%", () => {
    fc.assert(
      fc.property(percentSpecArb, amountArb, amountArb, (spec, a, b) => {
        const feeA = computeFee(spec, centimes(a));
        const feeB = computeFee(spec, centimes(b));
        if (a <= b) expect(feeA).toBeLessThanOrEqual(feeB);
        // rates ≤ 100% can never exceed the gross amount
        expect(feeA).toBeLessThanOrEqual(a);
      }),
    );
  });

  it("netAfterFee equals gross minus fee", () => {
    fc.assert(
      fc.property(percentSpecArb, amountArb, (spec, amount) => {
        const gross = centimes(amount);
        expect(netAfterFee(spec, gross)).toBe(amount - computeFee(spec, gross));
      }),
    );
  });

  it("applyBps is exact and whole-centime", () => {
    fc.assert(
      fc.property(amountArb, bpsArb, (amount, bps) => {
        const out = applyBps(amount, bps);
        expect(Number.isInteger(out)).toBe(true);
        // within one centime of the true rational value
        const exact = (amount * bps) / 10_000;
        expect(Math.abs(out - exact)).toBeLessThanOrEqual(0.5);
      }),
    );
  });
});

describe("TIERED bracket selection", () => {
  it("always applies exactly one bracket's rate", () => {
    const tiers: FeeTier[] = [
      { upToCents: 1000, percentageBps: 300 },
      { upToCents: 100000, percentageBps: 250 },
      { upToCents: Number.MAX_SAFE_INTEGER, percentageBps: 200 },
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (amount) => {
        const spec: FeeScheduleSpec = {
          feeType: "TIERED",
          flatCents: null,
          percentageBps: null,
          perMethodCents: null,
          tiersCents: tiers,
        };
        const fee = computeFee(spec, centimes(amount));
        const expectedRates = new Set(
          tiers.map((t) => Math.round((amount * t.percentageBps) / 10_000)),
        );
        expect(expectedRates.has(fee)).toBe(true);
      }),
    );
  });
});
