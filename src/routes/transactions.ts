import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';

const router = Router();

// ─── GET /transactions ────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const {
      page     = '1',
      limit    = '20',
      status,
      provider,
      dateFrom,
      dateTo,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: Record<string, unknown> = { tenantId: req.user!.tenantId };
    if (status)   where['status']   = status;
    if (provider) where['provider'] = provider;
    if (dateFrom || dateTo) {
      where['createdAt'] = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo   ? { lte: new Date(dateTo)   } : {}),
      };
    }

    const [intents, total] = await Promise.all([
      prisma.paymentIntent.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          paymentLink:  { select: { reference: true, amount: true, currency: true, description: true } },
          providerTxs:  { select: { providerTransactionId: true }, take: 1, orderBy: { createdAt: 'desc' } },
          refunds:      { select: { id: true, status: true, amount: true } },
        },
      }),
      prisma.paymentIntent.count({ where }),
    ]);

    res.json({
      data: intents.map((i) => ({
        id:                    i.id,
        correlationId:         i.correlationId,
        status:                i.status,
        provider:              i.provider,
        providerRef:           i.providerRef,
        providerTransactionId: i.providerTxs[0]?.providerTransactionId ?? null,
        amount:                i.paymentLink?.amount ?? null,
        currency:              i.paymentLink?.currency ?? null,
        reference:             i.paymentLink?.reference ?? null,
        description:           i.paymentLink?.description ?? null,
        hasRefund:             i.refunds.length > 0,
        refundStatus:          i.refunds[0]?.status ?? null,
        createdAt:             i.createdAt,
        updatedAt:             i.updatedAt,
      })),
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
    });
  }),
);

// ─── GET /transactions/:id ────────────────────────────────────────────────────────

router.get(
  '/:id',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: {
        paymentLink: {
          select: {
            id: true, slug: true, amount: true, currency: true,
            description: true, reference: true,
            customerName: true, customerEmail: true, customerPhone: true,
            provider: true, status: true, createdAt: true,
          },
        },
        providerTxs: {
          orderBy: { createdAt: 'asc' },
          select:  { id: true, provider: true, providerTransactionId: true, rawResponse: true, createdAt: true },
        },
        refunds: {
          orderBy: { createdAt: 'desc' },
          select:  { id: true, status: true, amount: true, currency: true, providerRefundRef: true, createdAt: true, updatedAt: true },
        },
        webhookEvents: {
          orderBy: { createdAt: 'asc' },
          select:  { id: true, provider: true, signatureVerified: true, processed: true, mappedStatus: true, processingError: true, createdAt: true },
        },
      },
    });

    if (!intent) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');

    // Build a sorted timeline
    type TimelineEntry = { type: string; timestamp: Date; detail: string };
    const timeline: TimelineEntry[] = [
      { type: 'INTENT_CREATED', timestamp: intent.createdAt, detail: 'Payment intent created' },
    ];
    if (intent.status === 'REQUIRES_ACTION' || intent.status === 'PROCESSING') {
      timeline.push({ type: 'CHECKOUT_OPENED', timestamp: intent.updatedAt, detail: 'Customer opened checkout' });
    }
    intent.webhookEvents.forEach((wh) => {
      timeline.push({
        type:      'WEBHOOK_RECEIVED',
        timestamp: wh.createdAt,
        detail:    `Webhook from ${wh.provider} – verified: ${wh.signatureVerified}, status: ${wh.mappedStatus ?? 'unknown'}`,
      });
    });
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(intent.status)) {
      timeline.push({ type: `PAYMENT_${intent.status}`, timestamp: intent.updatedAt, detail: `Payment ${intent.status.toLowerCase()}` });
    }
    intent.refunds.forEach((r) => {
      timeline.push({ type: 'REFUND_INITIATED', timestamp: r.createdAt, detail: `Refund ${r.status}` });
    });
    timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    res.json({ ...intent, timeline });
  }),
);

export default router;
