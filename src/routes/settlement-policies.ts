import { Router } from "express";
import type { SettlementPolicy } from "@/generated/prisma/client";

import {
  createSettlementPolicy,
  getActiveSettlementPolicy,
  listSettlementPolicies,
} from "../lib/policy-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createSettlementPolicySchema } from "../schemas/settlement-policies";

const router = Router();

function toResponse(row: SettlementPolicy) {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    industry: row.industry,
    mcc: row.mcc,
    availabilityMode: row.availabilityMode,
    availabilityDelayDays: row.availabilityDelayDays,
    reserveType: row.reserveType,
    reservePercentageBps: row.reservePercentageBps,
    reserveHoldDays: row.reserveHoldDays,
    reserveFixedCents: row.reserveFixedCents,
    payoutSchedule: row.payoutSchedule,
    payoutMinCents: row.payoutMinCents,
    reversalFunding: row.reversalFunding,
    allowNegative: row.allowNegative,
    splittingEnabled: row.splittingEnabled,
    feeScheduleId: row.feeScheduleId,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── GET /settlement-policies ────────────────────────────────────────────────────

// All versions for the tenant, newest first.
router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const rows = await listSettlementPolicies(req.user!.tenantId);
    res.json(rows.map(toResponse));
  }),
);

// ─── POST /settlement-policies ───────────────────────────────────────────────────

// Create a new active version (resolves the industry preset + overrides).
router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createSettlementPolicySchema.parse(req.body);
    const row = await createSettlementPolicy(req.user!.tenantId, input);
    res.status(201).json(toResponse(row));
  }),
);

// ─── GET /settlement-policies/active ─────────────────────────────────────────────

router.get(
  "/active",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const row = await getActiveSettlementPolicy(req.user!.tenantId);
    if (!row) {
      throw new AppError(404, "SETTLEMENT_POLICY_NOT_FOUND", "No active settlement policy");
    }
    res.json(toResponse(row));
  }),
);

export default router;
