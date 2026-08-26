import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESET,
  INDUSTRY_KEYS,
  INDUSTRY_PRESETS,
  presetForIndustry,
} from "./settlement-presets";
import { resolvePolicy, validatePolicy } from "./settlement-policy";

describe("settlement presets", () => {
  it("resolves a known industry to its preset", () => {
    const travel = presetForIndustry("travel");
    expect(travel.industry).toBe("travel");
    expect(travel.availabilityMode).toBe("DELAY");
    expect(travel.reservePercentageBps).toBe(1000);
  });

  it("falls back to the default preset for unknown/missing industry", () => {
    expect(presetForIndustry("does-not-exist")).toBe(DEFAULT_PRESET);
    expect(presetForIndustry(undefined)).toBe(DEFAULT_PRESET);
    expect(presetForIndustry(null)).toBe(DEFAULT_PRESET);
  });

  it("every industry preset is complete and validates", () => {
    expect(INDUSTRY_KEYS.length).toBeGreaterThan(0);
    for (const key of INDUSTRY_KEYS) {
      expect(() => validatePolicy(resolvePolicy(INDUSTRY_PRESETS[key]))).not.toThrow();
    }
  });
});
