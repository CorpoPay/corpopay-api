import { Router } from "express";
import type { FeeSchedule } from "@/generated/prisma/client";

import {
  createFeeSchedule,
  getActiveFeeSchedule,
  listFeeSchedules,
  toFeeSpec,
} from "../lib/fees-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createFeeScheduleSchema } from "../schemas/fee-schedules";

const router = Router();

function toResponse(row: FeeSchedule) {
  const spec = toFeeSpec(row);
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    feeType: row.feeType,
    flatCents: spec.flatCents,
    percentageBps: spec.percentageBps,
    perMethodCents: spec.perMethodCents,
    tiersCents: spec.tiersCents,
    currency: row.currency,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── GET /fee-schedules ──────────────────────────────────────────────────────────

// All versions for the tenant, newest first.
router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const rows = await listFeeSchedules(req.user!.tenantId);
    res.json(rows.map(toResponse));
  }),
);

// ─── POST /fee-schedules ─────────────────────────────────────────────────────────

// Create a new active version (deactivates the prior one).
router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createFeeScheduleSchema.parse(req.body);
    const row = await createFeeSchedule(req.user!.tenantId, input);
    res.status(201).json(toResponse(row));
  }),
);

// ─── GET /fee-schedules/active ───────────────────────────────────────────────────

router.get(
  "/active",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const row = await getActiveFeeSchedule(req.user!.tenantId);
    if (!row) throw new AppError(404, "FEE_SCHEDULE_NOT_FOUND", "No active fee schedule");
    res.json(toResponse(row));
  }),
);

export default router;
