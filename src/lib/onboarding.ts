/**
 * Onboarding / KYC / KYB engine (PayFac) — pure, side-effect-free.
 *
 * `MerchantOnboarding` is the last gate before a tenant goes live. It collects
 * KYC/KYB identity plus the tenant's `industry`/`mcc`, derives a `riskTier`, and
 * — on approval — resolves the `SettlementPolicy` preset that the tenant's money
 * engine defaults to. The single high-value signal is `industry`: it is the one
 * input that parameterizes a tenant's finance engine out of the box, via the
 * existing `presetForIndustry` → `resolvePolicy` chain (no new code path per
 * vertical).
 *
 * Everything here is pure and property-testable. Persistence + lifecycle wiring
 * lives in `onboarding-db.ts`. Amounts are irrelevant here (onboarding carries no
 * money) — the money invariant is enforced where money actually moves.
 */
import type { OnboardingStatus, RiskTier } from "@/generated/prisma/client";

import { type PolicySpec, resolvePolicy } from "./settlement-policy";
import { presetForIndustry } from "./settlement-presets";

export const ONBOARDING_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "NEEDS_INFO",
] as const;

export const RISK_TIERS = ["LOW", "MEDIUM", "HIGH"] as const;

export class OnboardingError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = "ONBOARDING_ERROR",
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

/** Allowed outgoing transitions per status. `APPROVED` is terminal. */
const TRANSITIONS: Record<OnboardingStatus, readonly OnboardingStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED", "NEEDS_INFO"],
  APPROVED: [],
  // A rejected / info-needed merchant may correct their data and resubmit.
  REJECTED: ["SUBMITTED"],
  NEEDS_INFO: ["SUBMITTED"],
};

export function canTransition(from: OnboardingStatus, to: OnboardingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OnboardingStatus, to: OnboardingStatus): void {
  if (!canTransition(from, to)) {
    throw new OnboardingError(
      `illegal onboarding transition ${from} -> ${to}`,
      409,
      "ONBOARDING_CONFLICT",
    );
  }
}

/** The KYC/KYB + industry fields a merchant fills in. */
export interface OnboardingFields {
  legalName?: string | null;
  entityType?: string | null;
  registrationNumber?: string | null;
  country?: string | null;
  businessAddress?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  industry?: string | null;
  mcc?: string | null;
  riskTier?: RiskTier | null;
}

/** Fields that must be present (and non-blank) before submission. */
const REQUIRED_SUBMIT_FIELDS = ["legalName", "entityType", "country", "industry", "mcc"] as const;

/**
 * Validate that an onboarding is complete enough to submit. Throws
 * `OnboardingError` naming the first missing field.
 */
export function validateOnboarding(fields: OnboardingFields): void {
  for (const key of REQUIRED_SUBMIT_FIELDS) {
    const value = fields[key];
    if (value == null || (typeof value === "string" && value.trim() === "")) {
      throw new OnboardingError(`cannot submit: ${key} is required`, 422, "ONBOARDING_INCOMPLETE");
    }
  }
}

/**
 * A suggested risk tier for a vertical. High-risk verticals (travel, lending)
 * need extra scrutiny; low-risk (saas, retail, escrow) need less. Used as the
 * default when a reviewer does not explicitly set `riskTier`.
 */
export function suggestedRiskTier(industry?: string | null): RiskTier {
  switch (industry) {
    case "travel":
    case "lending":
      return "HIGH";
    case "marketplace":
    case "on_demand":
      return "MEDIUM";
    case "saas":
    case "retail":
    case "escrow":
      return "LOW";
    default:
      return "MEDIUM";
  }
}

/**
 * Resolve a tenant's `industry` into the complete `SettlementPolicy` spec it
 * defaults to. This is the "industry → policy preset" signal: the tenant's
 * finance engine is parameterized out of the box by a single value. `mcc`
 * overrides the preset's category code when provided.
 */
export function policySpecForIndustry(industry?: string | null, mcc?: string | null): PolicySpec {
  const preset = presetForIndustry(industry);
  const resolved = resolvePolicy(preset);
  return {
    ...resolved,
    industry: industry ?? preset.industry,
    mcc: mcc ?? preset.mcc,
  };
}
