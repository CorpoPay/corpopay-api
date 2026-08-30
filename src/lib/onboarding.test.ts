import { describe, expect, it } from "vitest";

import {
  assertTransition,
  canTransition,
  ONBOARDING_STATUSES,
  OnboardingError,
  type OnboardingFields,
  policySpecForIndustry,
  RISK_TIERS,
  suggestedRiskTier,
  validateOnboarding,
} from "./onboarding";
import { validatePolicy } from "./settlement-policy";

describe("ONBOARDING_STATUSES / RISK_TIERS", () => {
  it("lists every status and tier exactly once", () => {
    expect(ONBOARDING_STATUSES).toEqual([
      "DRAFT",
      "SUBMITTED",
      "APPROVED",
      "REJECTED",
      "NEEDS_INFO",
    ]);
    expect(new Set(ONBOARDING_STATUSES).size).toBe(ONBOARDING_STATUSES.length);
    expect(RISK_TIERS).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect(new Set(RISK_TIERS).size).toBe(RISK_TIERS.length);
  });
});

describe("canTransition / assertTransition", () => {
  it("allows the forward lifecycle", () => {
    expect(canTransition("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "APPROVED")).toBe(true);
    expect(canTransition("SUBMITTED", "REJECTED")).toBe(true);
    expect(canTransition("SUBMITTED", "NEEDS_INFO")).toBe(true);
  });

  it("allows resubmission after rejection or info-needed", () => {
    expect(canTransition("REJECTED", "SUBMITTED")).toBe(true);
    expect(canTransition("NEEDS_INFO", "SUBMITTED")).toBe(true);
  });

  it("is terminal once approved", () => {
    for (const next of ONBOARDING_STATUSES) {
      expect(canTransition("APPROVED", next)).toBe(false);
    }
  });

  it("throws a 409 OnboardingError for an illegal transition", () => {
    expect(() => assertTransition("DRAFT", "APPROVED")).toThrow(OnboardingError);
    expect(() => assertTransition("APPROVED", "SUBMITTED")).toThrow(/APPROVED -> SUBMITTED/);
    try {
      assertTransition("APPROVED", "REJECTED");
    } catch (err) {
      expect(err).toBeInstanceOf(OnboardingError);
      expect((err as OnboardingError).statusCode).toBe(409);
      expect((err as OnboardingError).code).toBe("ONBOARDING_CONFLICT");
    }
  });
});

describe("validateOnboarding", () => {
  const complete: OnboardingFields = {
    legalName: "Acme SARL",
    entityType: "llc",
    country: "MA",
    industry: "retail",
    mcc: "5999",
  };

  function missing(field: string): OnboardingFields {
    const copy: Record<string, unknown> = { ...complete };
    copy[field] = null;
    return copy as OnboardingFields;
  }

  it("accepts a complete onboarding", () => {
    expect(() => validateOnboarding(complete)).not.toThrow();
  });

  it("requires every submit-required field", () => {
    for (const field of ["legalName", "entityType", "country", "industry", "mcc"]) {
      expect(() => validateOnboarding(missing(field))).toThrow(new RegExp(field));
    }
  });

  it("rejects a blank required field", () => {
    expect(() => validateOnboarding({ ...complete, legalName: "   " })).toThrow(/legalName/);
  });

  it("returns a 422 OnboardingError naming the missing field", () => {
    try {
      validateOnboarding({ ...complete, industry: null });
    } catch (err) {
      expect(err).toBeInstanceOf(OnboardingError);
      expect((err as OnboardingError).statusCode).toBe(422);
      expect((err as OnboardingError).code).toBe("ONBOARDING_INCOMPLETE");
    }
  });
});

describe("suggestedRiskTier", () => {
  it.each([
    ["travel", "HIGH"],
    ["lending", "HIGH"],
    ["marketplace", "MEDIUM"],
    ["on_demand", "MEDIUM"],
    ["saas", "LOW"],
    ["retail", "LOW"],
    ["escrow", "LOW"],
    ["unknown", "MEDIUM"],
    [null, "MEDIUM"],
  ] as const)("suggests %s for %j", (industry, tier) => {
    expect(suggestedRiskTier(industry)).toBe(tier);
  });
});

describe("policySpecForIndustry", () => {
  it("defaults the saas preset (no reserve, immediate)", () => {
    const spec = policySpecForIndustry("saas");
    expect(spec.industry).toBe("saas");
    expect(spec.mcc).toBe("5734");
    expect(spec.availabilityMode).toBe("IMMEDIATE");
    expect(spec.reserveType).toBe("NONE");
  });

  it("enables splitting for marketplace and defaults the mcc", () => {
    const spec = policySpecForIndustry("marketplace");
    expect(spec.splittingEnabled).toBe(true);
    expect(spec.mcc).toBe("5262");
    expect(spec.payoutSchedule).toBe("THRESHOLD");
    expect(spec.payoutMinCents).toBe(100000);
  });

  it("allows lending to go negative (disbursement-first)", () => {
    const spec = policySpecForIndustry("lending");
    expect(spec.reversalFunding).toBe("ALLOW_NEGATIVE");
    expect(spec.allowNegative).toBe(true);
  });

  it("falls back to the general default for an unknown industry", () => {
    const spec = policySpecForIndustry("something-new");
    expect(spec.availabilityMode).toBe("IMMEDIATE");
    expect(spec.reserveType).toBe("ROLLING");
    expect(spec.industry).toBe("something-new");
  });

  it("overrides the preset mcc when provided", () => {
    const spec = policySpecForIndustry("retail", "1234");
    expect(spec.mcc).toBe("1234");
    expect(spec.industry).toBe("retail");
  });

  it("returns a valid policy for every known industry", () => {
    for (const industry of [
      "saas",
      "marketplace",
      "retail",
      "travel",
      "escrow",
      "lending",
      "on_demand",
    ]) {
      expect(() => validatePolicy(policySpecForIndustry(industry))).not.toThrow();
    }
  });
});
