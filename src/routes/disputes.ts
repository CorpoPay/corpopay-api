import { Router } from "express";

import { centimes, madToCentimes } from "../lib/money";
import {
  createDispute,
  type DisputeWithRecovery,
  getDispute,
  listDisputes,
  resolveDispute,
} from "../lib/reversals-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createDisputeSchema, resolveDisputeSchema } from "../schemas/disputes";

const router = Router();

function toResponse(d: DisputeWithRecovery) {
  return {
    id: d.id,
    status: d.status,
    provider: d.provider,
    providerDisputeId: d.providerDisputeId,
    paymentIntentId: d.paymentIntentId,
    amountCents: madToCentimes(d.amount),
    feeCents: madToCentimes(d.feeAmount),
    currency: d.currency,
    reason: d.reason,
    evidenceDueDate: d.evidenceDueDate,
    recovery: d.recovery
      ? {
          id: d.recovery.id,
          status: d.recovery.status,
          amountCents: madToCentimes(d.recovery.amount),
          currency: d.recovery.currency,
          createdAt: d.recovery.createdAt,
        }
      : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// ─── POST /disputes ─────────────────────────────────────────────────────────────

// Record an inbound chargeback/dispute (idempotent by providerDisputeId).
router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createDisputeSchema.parse(req.body);
    const dispute = await createDispute(req.user!.tenantId, {
      providerDisputeId: input.providerDisputeId,
      provider: input.provider,
      amountCents: centimes(input.amount),
      feeCents: input.feeAmount != null ? centimes(input.feeAmount) : undefined,
      currency: input.currency ?? undefined,
      reason: input.reason,
      paymentIntentId: input.paymentIntentId,
      evidenceDueDate: input.evidenceDueDate,
    });
    res.status(201).json(toResponse(dispute));
  }),
);

// ─── GET /disputes ──────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const disputes = await listDisputes(req.user!.tenantId);
    res.json(disputes.map(toResponse));
  }),
);

// ─── GET /disputes/:id ──────────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const dispute = await getDispute(req.user!.tenantId, req.params.id);
    if (!dispute) throw new AppError(404, "DISPUTE_NOT_FOUND", "Dispute not found");
    res.json(toResponse(dispute));
  }),
);

// ─── POST /disputes/:id/resolve ─────────────────────────────────────────────────

// Resolve to WON (no money moves) or LOST (execute the clawback + recovery).
router.post(
  "/:id/resolve",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = resolveDisputeSchema.parse(req.body);
    const dispute = await resolveDispute(req.user!.tenantId, req.params.id, input.outcome);
    res.json(toResponse(dispute));
  }),
);

export default router;
