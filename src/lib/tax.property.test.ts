import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyBps } from "./fees";
import { centimes } from "./money";
import { computeTax } from "./tax";

describe("computeTax (property)", () => {
  it("equals applyBps when taxed, and 0 when exempt", () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(10_000), fc.boolean(), (fee, bps, exempt) => {
        const expected = exempt ? 0 : applyBps(centimes(fee), bps);
        expect(computeTax(centimes(fee), { taxRateBps: bps, taxExempt: exempt })).toBe(expected);
      }),
    );
  });

  it("is a non-negative whole centime, never exceeding the fee at ≤100%", () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(10_000), (fee, bps) => {
        const tax = computeTax(centimes(fee), { taxRateBps: bps });
        expect(Number.isInteger(tax)).toBe(true);
        expect(tax).toBeGreaterThanOrEqual(0);
        expect(tax).toBeLessThanOrEqual(fee);
      }),
    );
  });
});
