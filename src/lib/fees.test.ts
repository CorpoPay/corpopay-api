import { describe, expect, it } from "vitest";

import { applyBps, computeFee, FeeError, type FeeScheduleSpec, netAfterFee } from "./fees";
import { centimes } from "./money";

const pct = (percentageBps: number): FeeScheduleSpec => ({
  feeType: "PERCENTAGE",
  flatCents: null,
  percentageBps,
  perMethodCents: null,
  tiersCents: null,
});

describe("computeFee", () => {
  it("FLAT returns the fixed fee regardless of amount", () => {
    const s: FeeScheduleSpec = {
      feeType: "FLAT",
      flatCents: 250,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: null,
    };
    expect(computeFee(s, centimes(100000))).toBe(250);
    expect(computeFee(s, centimes(1))).toBe(250);
  });

  it("PERCENTAGE applies basis points with half-up rounding", () => {
    expect(computeFee(pct(290), centimes(100000))).toBe(2900); // 2.9% of 1000.00 MAD
    expect(computeFee(pct(10000), centimes(100))).toBe(100); // 100% of 1.00 MAD
    expect(computeFee(pct(1), centimes(5000))).toBe(1); // 0.5 centime rounds up
  });

  it("PER_METHOD returns the method-specific flat fee (0 for unknown/missing method)", () => {
    const s: FeeScheduleSpec = {
      feeType: "PER_METHOD",
      flatCents: null,
      percentageBps: null,
      perMethodCents: { card: 200, bank_transfer: 0 },
      tiersCents: null,
    };
    expect(computeFee(s, centimes(100000), "card")).toBe(200);
    expect(computeFee(s, centimes(100000), "bank_transfer")).toBe(0);
    expect(computeFee(s, centimes(100000), "unknown")).toBe(0);
    expect(computeFee(s, centimes(100000))).toBe(0); // no method → 0
  });

  it("TIERED selects the first bracket that covers the amount (last is catch-all)", () => {
    const s: FeeScheduleSpec = {
      feeType: "TIERED",
      flatCents: null,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: [
        { upToCents: 100000, percentageBps: 290 },
        { upToCents: 1000000, percentageBps: 250 },
        { upToCents: Number.MAX_SAFE_INTEGER, percentageBps: 200 },
      ],
    };
    expect(computeFee(s, centimes(50000))).toBe(1450); // 2.9%
    expect(computeFee(s, centimes(500000))).toBe(12500); // 2.5%
    expect(computeFee(s, centimes(5000000))).toBe(100000); // 2.0%
  });

  it("TIERED with no tiers returns zero", () => {
    const s: FeeScheduleSpec = {
      feeType: "TIERED",
      flatCents: null,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: [],
    };
    expect(computeFee(s, centimes(100000))).toBe(0);
  });

  it("rejects negative amounts", () => {
    expect(() => computeFee(pct(290), centimes(-1))).toThrow(FeeError);
  });

  it("rejects negative percentage / flat / per-method fees", () => {
    expect(() => computeFee(pct(-1), centimes(100))).toThrow(/non-negative/);
    const flat: FeeScheduleSpec = {
      feeType: "FLAT",
      flatCents: -1,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: null,
    };
    expect(() => computeFee(flat, centimes(100))).toThrow(/non-negative/);
  });
});

describe("applyBps", () => {
  it("rounds half away from zero and returns whole centimes", () => {
    expect(applyBps(10000, 50)).toBe(50); // exactly 0.5%
    expect(applyBps(9999, 50)).toBe(50); // 49.995 → 50
    expect(applyBps(100, 5)).toBe(0); // 0.05 → 0
  });
});

describe("netAfterFee", () => {
  it("subtracts the fee from gross", () => {
    expect(netAfterFee(pct(290), centimes(100000))).toBe(97100);
  });
});
