/**
 * Settlement-policy persistence.
 *
 * A `SettlementPolicy` is per-tenant and **versioned** (`@@unique([tenantId,
 * version])`). Creating a policy resolves the tenant's `industry`/`mcc` preset,
 * merges the per-tenant overrides on top, validates the result, and writes a
 * complete row — so a stored policy is self-contained (no preset re-resolution
 * needed at read time). Only one version is active per tenant at a time.
 */
import type {
  AvailabilityMode,
  PayoutSchedule,
  ReserveType,
  ReversalFundingPolicy,
  SettlementPolicy,
} from "@/generated/prisma/client";

import { prisma } from "./prisma";
import { type PolicySpec, resolvePolicy, validatePolicy } from "./settlement-policy";
import { presetForIndustry } from "./settlement-presets";

export interface SettlementPolicyInput {
  name?: string | null;
  industry?: string | null;
  mcc?: string | null;
  availabilityMode?: AvailabilityMode | null;
  availabilityDelayDays?: number | null;
  reserveType?: ReserveType | null;
  reservePercentageBps?: number | null;
  reserveHoldDays?: number | null;
  reserveFixedCents?: number | null;
  payoutSchedule?: PayoutSchedule | null;
  payoutMinCents?: number | null;
  reversalFunding?: ReversalFundingPolicy | null;
  allowNegative?: boolean | null;
  splittingEnabled?: boolean | null;
  feeScheduleId?: string | null;
}

/** Resolve the preset + overrides into a complete, validated policy. */
function resolveInput(input: SettlementPolicyInput): PolicySpec {
  const preset = presetForIndustry(input.industry);
  const resolved = resolvePolicy(preset, {
    availabilityMode: input.availabilityMode,
    availabilityDelayDays: input.availabilityDelayDays,
    reserveType: input.reserveType,
    reservePercentageBps: input.reservePercentageBps,
    reserveHoldDays: input.reserveHoldDays,
    reserveFixedCents: input.reserveFixedCents,
    payoutSchedule: input.payoutSchedule,
    payoutMinCents: input.payoutMinCents,
    reversalFunding: input.reversalFunding,
    allowNegative: input.allowNegative,
    splittingEnabled: input.splittingEnabled,
  });
  // industry/mcc are identity signals, not preset-derived dimensions — store the
  // tenant's raw input (or null) rather than the preset's canonical key.
  return { ...resolved, industry: input.industry ?? null, mcc: input.mcc ?? null };
}

/** Create a new active version (deactivating the prior one) atomically. */
export async function createSettlementPolicy(
  tenantId: string,
  input: SettlementPolicyInput,
): Promise<SettlementPolicy> {
  const resolved = resolveInput(input);
  validatePolicy(resolved);

  return prisma.$transaction(async (tx) => {
    const max = await tx.settlementPolicy.aggregate({
      where: { tenantId },
      _max: { version: true },
    });
    const version = (max._max.version ?? 0) + 1;

    await tx.settlementPolicy.updateMany({
      where: { tenantId, isActive: true },
      data: { isActive: false },
    });

    return tx.settlementPolicy.create({
      data: {
        tenantId,
        version,
        name: input.name ?? null,
        industry: resolved.industry,
        mcc: resolved.mcc,
        availabilityMode: resolved.availabilityMode,
        availabilityDelayDays: resolved.availabilityDelayDays,
        reserveType: resolved.reserveType,
        reservePercentageBps: resolved.reservePercentageBps,
        reserveHoldDays: resolved.reserveHoldDays,
        reserveFixedCents: resolved.reserveFixedCents,
        payoutSchedule: resolved.payoutSchedule,
        payoutMinCents: resolved.payoutMinCents,
        reversalFunding: resolved.reversalFunding,
        allowNegative: resolved.allowNegative,
        splittingEnabled: resolved.splittingEnabled,
        feeScheduleId: input.feeScheduleId ?? null,
        isActive: true,
      },
    });
  });
}

/** All versions for a tenant, newest first. */
export async function listSettlementPolicies(tenantId: string): Promise<SettlementPolicy[]> {
  return prisma.settlementPolicy.findMany({
    where: { tenantId },
    orderBy: { version: "desc" },
  });
}

/** The active policy for a tenant, or `null`. */
export async function getActiveSettlementPolicy(
  tenantId: string,
): Promise<SettlementPolicy | null> {
  return prisma.settlementPolicy.findFirst({
    where: { tenantId, isActive: true },
  });
}
