/**
 * Merchant API routes for Subscription management.
 *
 * GET    /subscriptions                – list tenant subscriptions
 * GET    /subscriptions/:id            – subscription detail with billing events
 * POST   /subscriptions/:id/pause      – pause (stop future charges)
 * POST   /subscriptions/:id/resume     – resume a paused subscription
 * DELETE /subscriptions/:id            – cancel (no future charges, immediate)
 * GET    /subscriptions/:id/events     – paginated billing events
 */
import { Router } from "express";
import { z } from "zod";
import { billingIdempotencyKey } from "../lib/billing";
import { inngest } from "../lib/inngest";
import { madToCentimes } from "../lib/money";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── GET /subscriptions ───────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const { page = "1", limit = "20", status, customerId } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const db = forTenant(req.user!.tenantId);
    const where = {
      ...(status ? { status: status as any } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [subscriptions, total] = await Promise.all([
      db.subscription.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { billingEvents: true } },
        },
      }),
      db.subscription.count({ where }),
    ]);

    res.json({
      data: subscriptions.map((s) => ({
        id: s.id,
        customerId: s.customerId,
        status: s.status,
        amount: s.amount,
        currency: s.currency,
        intervalType: s.intervalType,
        intervalValue: s.intervalValue,
        nextBillingDate: s.nextBillingDate,
        retryCount: s.retryCount,
        billingEventCount: s._count.billingEvents,
        createdAt: s.createdAt,
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  }),
);

// ─── GET /subscriptions/:id ───────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const sub = await db.subscription.findFirst({
      where: { id: req.params.id },
      include: {
        billingEvents: {
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });
    if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");

    // Never expose the encrypted profile ID
    const { encryptedStoredProfileId: _redacted, ...safeSub } = sub;

    res.json(safeSub);
  }),
);

// ─── POST /subscriptions/:id/pause ───────────────────────────────────────────

router.post(
  "/:id/pause",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const sub = await db.subscription.findFirst({
      where: { id: req.params.id },
    });
    if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");
    if (sub.status !== "ACTIVE" && sub.status !== "PAST_DUE") {
      throw new AppError(
        400,
        "INVALID_STATE",
        `Cannot pause a subscription in ${sub.status} state`,
      );
    }

    // Cancel the active Inngest run so no pending/sleeping billing renewal fires
    if (sub.inngestRunId) {
      try {
        await inngest.send({
          name: "billing/subscription.pause-requested",
          data: { subscriptionId: sub.id, runId: sub.inngestRunId },
        });
      } catch {
        // Non-fatal — the subscription status update is the source of truth
      }
    }

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "PAUSED", inngestRunId: null },
    });

    res.json({ id: updated.id, status: updated.status });
  }),
);

// ─── POST /subscriptions/:id/resume ──────────────────────────────────────────

router.post(
  "/:id/resume",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const sub = await db.subscription.findFirst({
      where: { id: req.params.id },
    });
    if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");
    if (sub.status !== "PAUSED") {
      throw new AppError(
        400,
        "INVALID_STATE",
        `Cannot resume a subscription in ${sub.status} state`,
      );
    }

    const now = new Date();
    // M-7: If nextBillingDate is in the past (subscription was paused for a long
    // time), use 'now' so the charge fires immediately with a fresh key rather
    // than re-submitting a stale date that Inngest may have already seen.
    const dueDate = new Date(Math.max((sub.nextBillingDate ?? now).getTime(), now.getTime()));
    const idemKey = billingIdempotencyKey(sub.id, dueDate);

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "ACTIVE" },
    });

    // Fire a renewal event immediately (the daily sweep would catch it, this is faster)
    await inngest.send({
      id: idemKey,
      name: "billing/renewal.due",
      data: {
        subscriptionId: sub.id,
        tenantId: sub.tenantId,
        customerId: sub.customerId,
        amount: madToCentimes(sub.amount),
        currency: sub.currency,
        intervalType: sub.intervalType,
        intervalValue: sub.intervalValue,
        chargeId: `renewal-${idemKey}`,
        idempotencyId: idemKey,
        attemptNumber: 1,
      },
    });

    res.json({ id: sub.id, status: "ACTIVE" });
  }),
);

// ─── DELETE /subscriptions/:id ────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const sub = await db.subscription.findFirst({
      where: { id: req.params.id },
    });
    if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");
    if (sub.status === "CANCELLED") {
      throw new AppError(400, "ALREADY_CANCELLED", "Subscription is already cancelled");
    }

    if (sub.inngestRunId) {
      try {
        await inngest.send({
          name: "billing/subscription.cancel-requested",
          data: { subscriptionId: sub.id, runId: sub.inngestRunId },
        });
      } catch {
        // Non-fatal
      }
    }

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "CANCELLED", inngestRunId: null },
    });

    res.json({ id: updated.id, status: updated.status });
  }),
);

// ─── GET /subscriptions/:id/events ───────────────────────────────────────────

router.get(
  "/:id/events",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const sub = await db.subscription.findFirst({
      where: { id: req.params.id },
    });
    if (!sub) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");

    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [events, total] = await Promise.all([
      prisma.billingEvent.findMany({
        where: { subscriptionId: sub.id },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
      }),
      prisma.billingEvent.count({ where: { subscriptionId: sub.id } }),
    ]);

    res.json({ data: events, total, page: parseInt(page), limit: parseInt(limit) });
  }),
);

export default router;
