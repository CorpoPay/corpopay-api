import { Router } from "express";

import { AuditAction } from "@/generated/prisma/client";

import { getAdapter } from "../adapters/registry";
import { madToCentimes } from "../lib/money";
import { PayoutError } from "../lib/payout";
import {
  cancelPayout,
  createPayout,
  getPayout,
  listPayouts,
  markPayoutFailed,
  markPayoutPaid,
  type PayoutWithItems,
} from "../lib/payout-db";
import { getActiveSettlementPolicy } from "../lib/policy-db";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createPayoutSchema, processPayoutSchema } from "../schemas/payouts";

const router = Router();

function toResponse(payout: PayoutWithItems) {
  return {
    id: payout.id,
    status: payout.status,
    provider: payout.provider,
    method: payout.method,
    currency: payout.currency,
    amountCents: madToCentimes(payout.amount),
    feeCents: madToCentimes(payout.feeAmount),
    providerTransferId: payout.providerTransferId,
    idempotencyKey: payout.idempotencyKey,
    items: payout.items.map((item) => ({
      id: item.id,
      ledgerEntryId: item.ledgerEntryId,
      amountCents: madToCentimes(item.amount),
    })),
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt,
  };
}

// ─── POST /payouts ────────────────────────────────────────────────────────────────

// Snapshot the eligible AVAILABLE balance into a DRAFT payout (idempotent).
router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createPayoutSchema.parse(req.body);
    const payout = await createPayout(req.user!.tenantId, input);
    res.status(201).json(toResponse(payout));
  }),
);

// ─── GET /payouts ─────────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const payouts = await listPayouts(req.user!.tenantId);
    res.json(payouts.map(toResponse));
  }),
);

// ─── GET /payouts/:id ─────────────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const payout = await getPayout(req.user!.tenantId, req.params.id);
    if (!payout) throw new AppError(404, "PAYOUT_NOT_FOUND", "Payout not found");
    res.json(toResponse(payout));
  }),
);

// ─── POST /payouts/:id/cancel ─────────────────────────────────────────────────────

router.post(
  "/:id/cancel",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    await cancelPayout(req.user!.tenantId, req.params.id);
    const payout = await getPayout(req.user!.tenantId, req.params.id);
    res.json(toResponse(payout!));
  }),
);

// ─── POST /payouts/:id/process ────────────────────────────────────────────────────

// Post the settlement movement (AVAILABLE → PAID_OUT) for a payout, surfacing
// money/state conflicts (already-paid, insufficient funds) as a 409 rather than
// a generic 500. The provider transfer must already have succeeded on the
// STRIPE_CONNECT rail, or be confirmed by the operator on the MANUAL rail.
async function settlePayout(tenantId: string, id: string, providerTransferId?: string) {
  try {
    return await markPayoutPaid(tenantId, id, providerTransferId);
  } catch (err) {
    if (err instanceof PayoutError) {
      throw new AppError(409, "PAYOUT_CONFLICT", err.message);
    }
    throw err;
  }
}

// Execute the payout. Two rails:
//   - MANUAL (default): no provider call — the operator pays out-of-band (e.g.
//     a Morocco bank transfer) and confirms here, optionally with a transfer
//     reference, which posts the settlement movement.
//   - STRIPE_CONNECT: call the provider's disbursement, then settle.
router.post(
  "/:id/process",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const tenantId = req.user!.tenantId;
    const payout = await getPayout(tenantId, req.params.id);
    if (!payout) throw new AppError(404, "PAYOUT_NOT_FOUND", "Payout not found");

    const policy = await getActiveSettlementPolicy(tenantId);
    const rail = policy?.payoutRail ?? "MANUAL";

    if (rail === "MANUAL") {
      const { providerTransferId } = processPayoutSchema.parse(req.body);
      await settlePayout(tenantId, payout.id, providerTransferId ?? undefined);
      await prisma.auditLog.create({
        data: {
          tenantId,
          userId: req.user!.id,
          action: AuditAction.PAYOUT_MARKED_PAID,
          entityType: "Payout",
          entityId: payout.id,
          metadata: { payoutRail: "MANUAL", providerTransferId: providerTransferId ?? null },
          ip: req.ip,
        },
      });
      const full = await getPayout(tenantId, payout.id);
      res.json(toResponse(full!));
      return;
    }

    const db = forTenant(tenantId);
    const config = await db.providerConfig.findFirst({ where: { provider: payout.provider } });
    if (!config) throw new AppError(400, "PROVIDER_NOT_CONFIGURED", "Provider config missing");

    const adapter = getAdapter(payout.provider, config.encryptedCredentials);
    const result = await adapter.createPayout({
      amount: madToCentimes(payout.amount),
      currency: payout.currency,
      reference: payout.idempotencyKey,
      method: payout.method,
    });

    if (!result.success) {
      await markPayoutFailed(tenantId, payout.id);
      throw new AppError(502, "PAYOUT_FAILED", "Provider payout failed");
    }

    await settlePayout(tenantId, payout.id, result.providerTransferId);
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId: req.user!.id,
        action: AuditAction.PAYOUT_MARKED_PAID,
        entityType: "Payout",
        entityId: payout.id,
        metadata: { providerTransferId: result.providerTransferId },
        ip: req.ip,
      },
    });
    const full = await getPayout(tenantId, payout.id);
    res.json(toResponse(full!));
  }),
);

export default router;
