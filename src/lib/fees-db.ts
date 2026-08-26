/**
 * Fee-schedule persistence.
 *
 * A `FeeSchedule` is per-tenant and **versioned** (`@@unique([tenantId,
 * version])`). Creating a schedule bumps the version and deactivates the prior
 * active version, so exactly one schedule is active per tenant at a time.
 * `getActiveFeeSchedule` returns that row (or `null`).
 *
 * The `perMethodCents` and `tiersCents` Prisma `Json` columns are normalized
 * into the pure `FeeScheduleSpec` shape consumed by `computeFee`.
 */
import type { FeeSchedule, FeeType } from "@/generated/prisma/client";

import type { FeeScheduleSpec, FeeTier } from "./fees";
import { prisma } from "./prisma";

export interface FeeScheduleInput {
  name?: string | null;
  feeType: FeeType;
  flatCents?: number | null;
  percentageBps?: number | null;
  perMethodCents?: Record<string, number> | null;
  tiersCents?: FeeTier[] | null;
  currency?: string | null;
}

function jsonToRecord(v: unknown): Record<string, number> | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, number>;
}

function jsonToTiers(v: unknown): FeeTier[] | null {
  if (!Array.isArray(v)) return null;
  return v as FeeTier[];
}

/** Normalize a `FeeSchedule` row into the pure fee-engine shape. */
export function toFeeSpec(row: FeeSchedule): FeeScheduleSpec {
  return {
    feeType: row.feeType,
    flatCents: row.flatCents,
    percentageBps: row.percentageBps,
    perMethodCents: jsonToRecord(row.perMethodCents),
    tiersCents: jsonToTiers(row.tiersCents),
  };
}

/** Create a new active version (deactivating the prior one) atomically. */
export async function createFeeSchedule(
  tenantId: string,
  input: FeeScheduleInput,
): Promise<FeeSchedule> {
  return prisma.$transaction(async (tx) => {
    const max = await tx.feeSchedule.aggregate({
      where: { tenantId },
      _max: { version: true },
    });
    const version = (max._max.version ?? 0) + 1;

    await tx.feeSchedule.updateMany({
      where: { tenantId, isActive: true },
      data: { isActive: false },
    });

    return tx.feeSchedule.create({
      data: {
        tenantId,
        version,
        name: input.name ?? null,
        feeType: input.feeType,
        flatCents: input.flatCents ?? null,
        percentageBps: input.percentageBps ?? null,
        perMethodCents: (input.perMethodCents ?? null) as never,
        tiersCents: (input.tiersCents ?? null) as never,
        currency: input.currency ?? "MAD",
        isActive: true,
      },
    });
  });
}

/** All versions for a tenant, newest first. */
export async function listFeeSchedules(tenantId: string): Promise<FeeSchedule[]> {
  return prisma.feeSchedule.findMany({
    where: { tenantId },
    orderBy: { version: "desc" },
  });
}

/** The active schedule for a tenant, or `null`. */
export async function getActiveFeeSchedule(tenantId: string): Promise<FeeSchedule | null> {
  return prisma.feeSchedule.findFirst({
    where: { tenantId, isActive: true },
  });
}
