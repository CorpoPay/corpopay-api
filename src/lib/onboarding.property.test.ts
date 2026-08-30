import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STATUSES,
  policySpecForIndustry,
  RISK_TIERS,
  suggestedRiskTier,
} from "./onboarding";
import { validatePolicy } from "./settlement-policy";

/**
 * Property tests for the onboarding engine.
 *
 * The key invariant: the `industry → policy preset` signal must ALWAYS produce a
 * valid, deterministic `SettlementPolicy` spec — no industry (known, unknown, or
 * garbage) may ever yield an invalid money-engine configuration.
 */

const industryArb = fc.oneof(
  fc.constantFrom("saas", "marketplace", "retail", "travel", "escrow", "lending", "on_demand"),
  fc.string({ minLength: 0, maxLength: 30 }),
);
const mccArb = fc.oneof(fc.string({ minLength: 1, maxLength: 10 }), fc.constant(null));

describe("onboarding properties", () => {
  it("policySpecForIndustry always yields a valid policy", () => {
    fc.assert(
      fc.property(industryArb, mccArb, (industry, mcc) => {
        expect(() => validatePolicy(policySpecForIndustry(industry, mcc))).not.toThrow();
      }),
    );
  });

  it("policySpecForIndustry is deterministic", () => {
    fc.assert(
      fc.property(industryArb, mccArb, (industry, mcc) => {
        expect(policySpecForIndustry(industry, mcc)).toEqual(policySpecForIndustry(industry, mcc));
      }),
    );
  });

  it("suggestedRiskTier always returns a valid tier", () => {
    fc.assert(
      fc.property(industryArb, (industry) => {
        expect(RISK_TIERS).toContain(suggestedRiskTier(industry));
      }),
    );
  });

  it("the status set is finite and duplicate-free", () => {
    expect(ONBOARDING_STATUSES).toHaveLength(5);
    expect(new Set(ONBOARDING_STATUSES).size).toBe(ONBOARDING_STATUSES.length);
  });
});
