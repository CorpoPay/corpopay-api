/**
 * Finance-config persistence (capability layer).
 *
 * A tenant's money model is the set of enabled capabilities (see finance-config.ts)
 * plus per-capability settings such as the wallet commission basis. A missing row
 * means the tenant runs on the default preset; an explicit row stores the tenant's
 * toggles. Capability gating reads through `requireCapability`.
 */
import type { FinanceConfig as FinanceConfigRecord, Prisma } from "@/generated/prisma/client";

import { AppError } from "../middleware/errorHandler";
import {
  DEFAULT_WALLET_COMMISSION_BASIS,
  FINANCE_PRESETS,
  type FinanceCapability,
  type FinancePreset,
  validateFinanceConfig,
  type WalletCommissionBasis,
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

/** Effective wallet commission basis from a row (default `usage`). */
export function resolveWalletCommissionBasis(
  row: Pick<FinanceConfigRecord, "walletCommissionBasis"> | null,
): WalletCommissionBasis {
  return row?.walletCommissionBasis === "load" ? "load" : DEFAULT_WALLET_COMMISSION_BASIS;
}

/** Effective wallet commission basis for a tenant, optionally inside a transaction. */
export async function getEffectiveWalletCommissionBasis(
  tenantId: string,
  tx?: Prisma.TransactionClient,
): Promise<WalletCommissionBasis> {
  const client = tx ?? prisma;
  const row = await client.financeConfig.findUnique({ where: { tenantId } });
  return resolveWalletCommissionBasis(row);
}

export interface UpsertFinanceConfigInput {
  capabilities: string[];
  preset?: string | null;
  walletCommissionBasis?: WalletCommissionBasis | null;
}

/** Validate + persist a tenant's finance config (idempotent upsert). */
export async function upsertFinanceConfig(
  tenantId: string,
  input: UpsertFinanceConfigInput,
): Promise<FinanceConfigRecord> {
  const violations = validateFinanceConfig({
    capabilities: input.capabilities,
    walletCommissionBasis: input.walletCommissionBasis,
  });
  if (violations.length > 0) {
    throw new AppError(422, "INVALID_FINANCE_CONFIG", violations.map((v) => v.message).join("; "));
  }

  const normalized = [...new Set(input.capabilities)];
  const basis = input.walletCommissionBasis ?? DEFAULT_WALLET_COMMISSION_BASIS;
  return prisma.financeConfig.upsert({
    where: { tenantId },
    create: {
      tenantId,
      capabilities: normalized,
      preset: input.preset ?? "custom",
      walletCommissionBasis: basis,
    },
    update: {
      capabilities: normalized,
      preset: input.preset ?? "custom",
      walletCommissionBasis: basis,
    },
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
