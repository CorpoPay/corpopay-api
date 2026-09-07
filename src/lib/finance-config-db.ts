/**
 * Finance-config persistence (capability layer).
 *
 * A tenant's money model is the set of enabled capabilities (see finance-config.ts).
 * A missing row means the tenant runs on the default preset; an explicit row stores
 * the tenant's toggles. Capability gating reads through `requireCapability`.
 */
import type { FinanceConfig as FinanceConfigRecord } from "@/generated/prisma/client";

import { AppError } from "../middleware/errorHandler";
import {
  FINANCE_PRESETS,
  type FinanceCapability,
  type FinancePreset,
  validateFinanceCapabilities,
} from "./finance-config";
import { prisma } from "./prisma";

/**
 * Baseline preset for a tenant with no stored config. `full` keeps every tenant
 * backward-compatible and matches "total flexibility" — gating only applies once
 * a tenant has an explicit (subset) config row.
 */
export const DEFAULT_FINANCE_PRESET: FinancePreset = "full";

export async function getFinanceConfig(tenantId: string): Promise<FinanceConfigRecord | null> {
  return prisma.financeConfig.findUnique({ where: { tenantId } });
}

/** Effective capabilities: the stored toggles, or the default preset when absent. */
export async function getEffectiveCapabilities(tenantId: string): Promise<FinanceCapability[]> {
  const row = await getFinanceConfig(tenantId);
  if (!row) return [...FINANCE_PRESETS[DEFAULT_FINANCE_PRESET]];
  return row.capabilities as FinanceCapability[];
}

/** Validate + persist a tenant's capability set (idempotent upsert). */
export async function upsertFinanceConfig(
  tenantId: string,
  capabilities: string[],
  preset?: string | null,
): Promise<FinanceConfigRecord> {
  const violations = validateFinanceCapabilities(capabilities);
  if (violations.length > 0) {
    throw new AppError(422, "INVALID_FINANCE_CONFIG", violations.map((v) => v.message).join("; "));
  }

  const normalized = [...new Set(capabilities)];
  return prisma.financeConfig.upsert({
    where: { tenantId },
    create: { tenantId, capabilities: normalized, preset: preset ?? "custom" },
    update: { capabilities: normalized, preset: preset ?? "custom" },
  });
}

/** Gate a feature on a capability; throws 403 when disabled. */
export async function requireCapability(
  tenantId: string,
  capability: FinanceCapability,
): Promise<void> {
  const caps = await getEffectiveCapabilities(tenantId);
  if (!caps.includes(capability)) {
    throw new AppError(
      403,
      "CAPABILITY_DISABLED",
      `Feature "${capability}" is not enabled for this tenant`,
    );
  }
}
