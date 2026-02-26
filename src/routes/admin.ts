/**
 * Admin-only routes (Support Admin + Super Admin).
 * Mounted at /admin in app.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Provider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';

const router = Router();

// ─── GET /admin/payments/search ───────────────────────────────────────────────────

router.get(
  '/payments/search',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { q } = req.query as { q?: string };
    if (!q || q.trim().length < 2) {
      throw new AppError(400, 'QUERY_TOO_SHORT', 'Search query must be at least 2 characters');
    }

    const term = q.trim();

    // Search across multiple identifiers
    const [byId, byCorrelation, byProviderRef, byReference, bySlug] = await Promise.all([
      prisma.paymentIntent.findFirst({
        where: { id: term },
        include: { paymentLink: true, providerTxs: true, webhookEvents: { orderBy: { createdAt: 'asc' } }, refunds: true },
      }),
      prisma.paymentIntent.findFirst({
        where: { correlationId: term },
        include: { paymentLink: true, providerTxs: true, webhookEvents: { orderBy: { createdAt: 'asc' } }, refunds: true },
      }),
      prisma.paymentIntent.findFirst({
        where: { providerRef: term },
        include: { paymentLink: true, providerTxs: true, webhookEvents: { orderBy: { createdAt: 'asc' } }, refunds: true },
      }),
      prisma.paymentIntent.findFirst({
        where: { paymentLink: { reference: term } },
        include: { paymentLink: true, providerTxs: true, webhookEvents: { orderBy: { createdAt: 'asc' } }, refunds: true },
      }),
      prisma.paymentIntent.findFirst({
        where: { paymentLink: { slug: term } },
        include: { paymentLink: true, providerTxs: true, webhookEvents: { orderBy: { createdAt: 'asc' } }, refunds: true },
      }),
    ]);

    // Also search by providerTransactionId
    const byProviderTxId = await (async () => {
      const ptx = await prisma.providerTransaction.findFirst({
        where: { providerTransactionId: term },
      });
      if (!ptx) return null;
      return prisma.paymentIntent.findFirst({
        where:   { id: ptx.paymentIntentId },
        include: { paymentLink: true, providerTxs: true, webhookEvents: { orderBy: { createdAt: 'asc' } }, refunds: true },
      });
    })();

    const result = byId ?? byCorrelation ?? byProviderRef ?? byReference ?? bySlug ?? byProviderTxId;

    if (!result) {
      return res.json({ found: false, intent: null });
    }

    return res.json({ found: true, intent: result });
  }),
);

// ─── GET /admin/webhooks ──────────────────────────────────────────────────────────

router.get(
  '/webhooks',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const {
      page       = '1',
      limit      = '20',
      provider,
      tenantId,
      verified,
      processed,
      dateFrom,
      dateTo,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: Record<string, unknown> = {};
    if (provider)  where['provider']          = provider as Provider;
    if (tenantId)  where['tenantId']          = tenantId;
    if (verified !== undefined)  where['signatureVerified'] = verified === 'true';
    if (processed !== undefined) where['processed']         = processed === 'true';
    if (dateFrom || dateTo) {
      where['createdAt'] = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo   ? { lte: new Date(dateTo)   } : {}),
      };
    }

    const [events, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, provider: true, tenantId: true, paymentIntentId: true,
          signatureVerified: true, processed: true, processingError: true,
          mappedStatus: true, idempotencyKey: true, createdAt: true,
          rawPayload: true, // already masked at storage time
        },
      }),
      prisma.webhookEvent.count({ where }),
    ]);

    res.json({ data: events, total, page: parseInt(page), limit: parseInt(limit) });
  }),
);

// ─── GET /admin/provider-health ────────────────────────────────────────────────────

router.get(
  '/provider-health',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const health = await prisma.providerHealth.findMany();
    // Ensure both providers appear even if no record exists yet
    const result = [Provider.NAPS, Provider.VPS].map((p) => {
      const record = health.find((h) => h.provider === p);
      return record ?? { provider: p, status: 'NORMAL', notes: null, updatedAt: null };
    });
    res.json(result);
  }),
);

// ─── PUT /admin/provider-health/:provider ─────────────────────────────────────────

router.put(
  '/provider-health/:provider',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const provider = z.enum(['NAPS', 'VPS']).parse(req.params.provider) as Provider;
    const { status, notes } = z.object({
      status: z.enum(['NORMAL', 'DEGRADED', 'DOWN']),
      notes:  z.string().max(500).optional(),
    }).parse(req.body);

    const record = await prisma.providerHealth.upsert({
      where:  { provider },
      create: { provider, status, notes },
      update: { status, notes },
    });

    res.json(record);
  }),
);

export default router;
