import { describe, expect, it } from "vitest";
import { centimes } from "./money";
import {
  availableAfterReserve,
  computeReserve,
  PolicyError,
  type PolicySpec,
  resolvePolicy,
  validatePolicy,
} from "./settlement-policy";
import { DEFAULT_PRESET, INDUSTRY_PRESETS } from "./settlement-presets";

function policy(overrides: Partial<PolicySpec> = {}): PolicySpec {
  return resolvePolicy(DEFAULT_PRESET, overrides as never);
}

describe("computeReserve", () => {
  it("NONE holds nothing", () => {
    expect(computeReserve(policy({ reserveType: "NONE" }), centimes(100000))).toBe(0);
  });

  it("FIXED holds the fixed amount, capped at gross", () => {
    const p = policy({ reserveType: "FIXED", reserveFixedCents: 5000 });
    expect(computeReserve(p, centimes(100000))).toBe(5000);
    expect(computeReserve(p, centimes(3000))).toBe(3000); // capped at gross
  });

  it("ROLLING holds the basis-point percentage of gross", () => {
    const p = policy({ reserveType: "ROLLING", reservePercentageBps: 500 });
    expect(computeReserve(p, centimes(100000))).toBe(5000); // 5% of 1000.00 MAD
  });

  it("rejects negative gross", () => {
    expect(() => computeReserve(policy(), centimes(-1))).toThrow(/non-negative/);
  });
});

describe("availableAfterReserve", () => {
  it("returns gross minus reserve", () => {
    const p = policy({ reserveType: "ROLLING", reservePercentageBps: 1000 });
    expect(availableAfterReserve(p, centimes(100000))).toBe(90000); // 1000 − 10% reserve
  });
});

describe("validatePolicy", () => {
  it("accepts a valid policy", () => {
    expect(() => validatePolicy(policy())).not.toThrow();
    expect(() => validatePolicy(resolvePolicy(INDUSTRY_PRESETS.travel))).not.toThrow();
  });

  it("rejects FIXED reserve without a fixed amount", () => {
    expect(() => validatePolicy(policy({ reserveType: "FIXED", reserveFixedCents: null }))).toThrow(
      /reserveFixedCents/,
    );
  });

  it("rejects ROLLING reserve without a percentage", () => {
    // Build a raw policy — `resolvePolicy` would backfill the preset's default
    // 500 bps, which is exactly the fallback behaviour under test elsewhere.
    const raw = { ...resolvePolicy(DEFAULT_PRESET), reservePercentageBps: null };
    expect(() => validatePolicy(raw)).toThrow(/reservePercentageBps/);
  });

  it("rejects DELAY availability without a delay", () => {
    expect(() =>
      validatePolicy(policy({ availabilityMode: "DELAY", availabilityDelayDays: null })),
    ).toThrow(/availabilityDelayDays/);
  });

  it("rejects THRESHOLD payout without a minimum", () => {
    expect(() =>
      validatePolicy(policy({ payoutSchedule: "THRESHOLD", payoutMinCents: null })),
    ).toThrow(/payoutMinCents/);
  });

  it("rejects ALLOW_NEGATIVE reversal without allowNegative", () => {
    expect(() =>
      validatePolicy(policy({ reversalFunding: "ALLOW_NEGATIVE", allowNegative: false })),
    ).toThrow(/allowNegative/);
  });

  it("rejects negative dimension values", () => {
    expect(() => validatePolicy(policy({ reservePercentageBps: -1 }))).toThrow(PolicyError);
  });
});

describe("resolvePolicy", () => {
  it("defaults every dimension to the preset", () => {
    const resolved = resolvePolicy(INDUSTRY_PRESETS.travel);
    expect(resolved.availabilityMode).toBe("DELAY");
    expect(resolved.availabilityDelayDays).toBe(7);
    expect(resolved.reserveType).toBe("ROLLING");
    expect(resolved.reservePercentageBps).toBe(1000);
    expect(resolved.payoutSchedule).toBe("AUTO_WEEKLY");
  });

  it("lets explicit overrides win and null fall back to the preset", () => {
    const resolved = resolvePolicy(INDUSTRY_PRESETS.travel, {
      reservePercentageBps: 2000,
      availabilityDelayDays: null,
    });
    expect(resolved.reservePercentageBps).toBe(2000);
    expect(resolved.availabilityDelayDays).toBe(7); // null → preset
  });

  it("has a complete default preset", () => {
    const resolved = resolvePolicy(DEFAULT_PRESET);
    expect(resolved.availabilityMode).toBe("IMMEDIATE");
    expect(resolved.reserveType).toBe("ROLLING");
    expect(resolved.reservePercentageBps).toBe(500);
    expect(resolved.payoutSchedule).toBe("AUTO_DAILY");
    expect(resolved.splittingEnabled).toBe(false);
  });
});
