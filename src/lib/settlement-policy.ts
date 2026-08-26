/**
 * Settlement policy engine (PayFac) — pure, centime-exact math.
 *
 * A `SettlementPolicy` parameterizes the six money-movement dimensions
 * (availability, reserve, payout schedule, reversal funding, splitting — plus
 * the fee model which lives in `fees.ts`). This module holds the **pure**
 * decision logic over those dimensions:
 *
 *   - `computeReserve` — the per-transaction reserve hold (centimes).
 *   - `availableAfterReserve` — gross − reserve, the amount eligible to pay out.
 *   - `validatePolicy` — the invariants a policy must satisfy before use.
 *
 * Everything here is pure and side-effect-free. Persistence (policy CRUD,
 * preset merge) lives in `policy-db.ts`.
 */
import type {
  AvailabilityMode,
  PayoutSchedule,
  ReserveType,
  ReversalFundingPolicy,
} from "@/generated/prisma/client";

import { applyBps } from "./fees";
import { type Centimes, centimes } from "./money";
import type { IndustryPreset } from "./settlement-presets";

export interface PolicySpec {
  industry: string | null;
  mcc: string | null;
  availabilityMode: AvailabilityMode;
  availabilityDelayDays: number | null;
  reserveType: ReserveType;
  reservePercentageBps: number | null;
  reserveHoldDays: number | null;
  reserveFixedCents: number | null;
  payoutSchedule: PayoutSchedule;
  payoutMinCents: number | null;
  reversalFunding: ReversalFundingPolicy;
  allowNegative: boolean;
  splittingEnabled: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Per-transaction reserve hold (centimes).
 *
 *   NONE    → 0
 *   FIXED   → `reserveFixedCents`, capped at gross (a hold can't exceed the
 *             transaction it comes from)
 *   ROLLING → `reservePercentageBps` of gross, rounded to the nearest centime
 */
export function computeReserve(policy: PolicySpec, grossCents: Centimes): Centimes {
  if (grossCents < 0) throw new PolicyError("gross must be non-negative");

  switch (policy.reserveType) {
    case "NONE":
      return centimes(0);
    case "FIXED":
      return centimes(Math.min(policy.reserveFixedCents ?? 0, grossCents));
    case "ROLLING":
      return applyBps(grossCents, policy.reservePercentageBps ?? 0);
  }
}

/** Gross minus the reserve hold — the portion eligible to settle out. */
export function availableAfterReserve(policy: PolicySpec, grossCents: Centimes): Centimes {
  return centimes(grossCents - computeReserve(policy, grossCents));
}

/**
 * Validate a policy's dimensions. Throws `PolicyError` on the first violation.
 * These are the guards that keep a malformed preset/override from producing
 * nonsense at payout time (negative reserve, a DELAY with no delay, …).
 */
export function validatePolicy(policy: PolicySpec): void {
  const nonNeg = (v: number | null, name: string): void => {
    if (v != null && v < 0) throw new PolicyError(`${name} must be non-negative`);
  };
  nonNeg(policy.reservePercentageBps, "reservePercentageBps");
  nonNeg(policy.reserveFixedCents, "reserveFixedCents");
  nonNeg(policy.availabilityDelayDays, "availabilityDelayDays");
  nonNeg(policy.reserveHoldDays, "reserveHoldDays");
  nonNeg(policy.payoutMinCents, "payoutMinCents");

  if (policy.reserveType === "FIXED" && policy.reserveFixedCents == null) {
    throw new PolicyError("FIXED reserve requires reserveFixedCents");
  }
  if (policy.reserveType === "ROLLING" && policy.reservePercentageBps == null) {
    throw new PolicyError("ROLLING reserve requires reservePercentageBps");
  }
  if (policy.availabilityMode === "DELAY" && policy.availabilityDelayDays == null) {
    throw new PolicyError("DELAY availability requires availabilityDelayDays");
  }
  if (policy.payoutSchedule === "THRESHOLD" && policy.payoutMinCents == null) {
    throw new PolicyError("THRESHOLD payout requires payoutMinCents");
  }
  if (policy.reversalFunding === "ALLOW_NEGATIVE" && !policy.allowNegative) {
    throw new PolicyError("ALLOW_NEGATIVE reversal funding requires allowNegative");
  }
}

/** The overridable subset of a policy; `null`/`undefined` means "use the preset". */
export type PolicyOverrides = { [K in keyof PolicySpec]?: PolicySpec[K] | null };

/**
 * Resolve a preset + per-tenant overrides into a complete policy. Every
 * dimension defaults to the preset value and is overridden only by an
 * explicitly-provided (non-null) override.
 */
export function resolvePolicy(preset: IndustryPreset, overrides: PolicyOverrides = {}): PolicySpec {
  return {
    industry: overrides.industry ?? preset.industry,
    mcc: overrides.mcc ?? preset.mcc,
    availabilityMode: overrides.availabilityMode ?? preset.availabilityMode,
    availabilityDelayDays: overrides.availabilityDelayDays ?? preset.availabilityDelayDays,
    reserveType: overrides.reserveType ?? preset.reserveType,
    reservePercentageBps: overrides.reservePercentageBps ?? preset.reservePercentageBps,
    reserveHoldDays: overrides.reserveHoldDays ?? preset.reserveHoldDays,
    reserveFixedCents: overrides.reserveFixedCents ?? preset.reserveFixedCents,
    payoutSchedule: overrides.payoutSchedule ?? preset.payoutSchedule,
    payoutMinCents: overrides.payoutMinCents ?? preset.payoutMinCents,
    reversalFunding: overrides.reversalFunding ?? preset.reversalFunding,
    allowNegative: overrides.allowNegative ?? preset.allowNegative,
    splittingEnabled: overrides.splittingEnabled ?? preset.splittingEnabled,
  };
}
