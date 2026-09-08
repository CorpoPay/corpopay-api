import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { computeTax, TaxError } from "./tax";

describe("computeTax", () => {
  it("returns 0 with no tax config", () => {
    expect(computeTax(centimes(290), null)).toBe(0);
    expect(computeTax(centimes(290), undefined)).toBe(0);
  });

  it("returns 0 when the tenant is exempt (reverse-charge)", () => {
    expect(computeTax(centimes(290), { taxRateBps: 2000, taxExempt: true })).toBe(0);
  });

  it("returns 0 for a zero rate", () => {
    expect(computeTax(centimes(290), { taxRateBps: 0 })).toBe(0);
  });

  it("computes tax on the fee (exclusive) in whole centimes", () => {
    // 20% VAT on a 2.90 fee = 0.58
    expect(computeTax(centimes(290), { taxRateBps: 2000 })).toBe(58);
  });

  it("rounds to the nearest centime (round half away from zero)", () => {
    expect(computeTax(centimes(291), { taxRateBps: 2000 })).toBe(58); // 58.2 → 58
    expect(computeTax(centimes(293), { taxRateBps: 2000 })).toBe(59); // 58.6 → 59
  });

  it("rejects a negative tax rate", () => {
    expect(() => computeTax(centimes(290), { taxRateBps: -1 })).toThrow(TaxError);
  });
});
