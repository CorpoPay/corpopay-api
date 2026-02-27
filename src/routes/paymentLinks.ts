import { Router } from 'express';
import { z } from 'zod';
import { BillingInterval, Provider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuditAction } from '@prisma/client';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────────

const CreatePaymentLinkSchema = z.object({
  amount:        z.number().positive().max(1_000_000_00), // centimes, max 1M MAD
  currency:      z.string().default('MAD'),
  description:   z.string().min(1).max(500),
  reference:     z.string().min(1).max(100),
  provider:      z.enum(['NAPS', 'VPS']),
  customerName:  z.string().max(100).optional(),
  customerEmail: z.string().email().optional().or(z.literal('')),
  customerPhone: z.string().max(20).optional(),
  expiresAt:     z.string().datetime().optional(),
  maxAttempts:   z.number().int().min(1).max(10).default(1),
  // ── Recurring billing ──────────────────────────────────────────────────────
  isRecurring:     z.boolean().default(false),
  billingInterval: z.nativeEnum(BillingInterval).optional(),
  intervalValue:   z.number().int().min(1).max(365).default(1),
  maxRetries:      z.number().int().min(1).max(10).default(3),
  // ── BNPL / Installments ─────────────────────────────────────────
  isInstallment:   z.boolean().default(false),
}).refine(
  (d) => !d.isRecurring || d.billingInterval != null,
  { message: 'billingInterval is required when isRecurring is true', path: ['billingInterval'] },
).refine(
  (d) => !d.isRecurring || d.provider === 'VPS',
  { message: 'Recurring billing is only supported with the VPS provider', path: ['provider'] },
).refine(
  (d) => !d.isInstallment || d.provider === 'VPS',
  { message: 'Installment billing is only supported with the VPS provider', path: ['provider'] },
).refine(
  (d) => !(d.isInstallment && d.isRecurring),
  { message: 'A payment link cannot be both installment and recurring', path: ['isInstallment'] },
);

// ─── POST /payment-links ──────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const data = CreatePaymentLinkSchema.parse(req.body);

    // Verify tenant has provider configured
    const providerConfig = await prisma.providerConfig.findFirst({
      where: {
        tenantId: req.user!.tenantId,
        provider: data.provider as Provider,
        status:   'CONNECTED',
      },
    });
    if (!providerConfig) {
      throw new AppError(
        400,
        'PROVIDER_NOT_CONFIGURED',
        `Provider ${data.provider} is not configured or not connected`,
      );
    }

    const link = await prisma.paymentLink.create({
      data: {
        tenantId:      req.user!.tenantId,
        amount:        data.amount / 100, // store as MAD decimal
        currency:      data.currency,
        description:   data.description,
        reference:     data.reference,
        provider:      data.provider as Provider,
        customerName:  data.customerName,
        customerEmail: data.customerEmail || undefined,
        customerPhone: data.customerPhone,
        expiresAt:     data.expiresAt ? new Date(data.expiresAt) : undefined,
        maxAttempts:   data.maxAttempts,
        isRecurring:     data.isRecurring,
        billingInterval: data.billingInterval ?? null,
        intervalValue:   data.intervalValue,
        maxRetries:      data.maxRetries,
        isInstallment:   data.isInstallment,
      },
    });

    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
    const checkoutUrl = `${webBase}/checkout/${link.slug}`;

    res.status(201).json({
      id:              link.id,
      slug:            link.slug,
      url:             checkoutUrl,
      amount:          link.amount,
      currency:        link.currency,
      description:     link.description,
      reference:       link.reference,
      status:          link.status,
      isRecurring:     link.isRecurring,
      billingInterval: link.billingInterval,
      intervalValue:   link.intervalValue,
      createdAt:       link.createdAt,
    });
  }),
);

// ─── GET /payment-links ───────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const {
      page = '1',
      limit = '20',
      status,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [links, total] = await Promise.all([
      prisma.paymentLink.findMany({
        where:  {
          tenantId: req.user!.tenantId,
          ...(status ? { status: status as any } : {}),
        },
        skip,
        take:    parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { paymentIntents: true } } },
      }),
      prisma.paymentLink.count({
        where: {
          tenantId: req.user!.tenantId,
          ...(status ? { status: status as any } : {}),
        },
      }),
    ]);

    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

    res.json({
      data: links.map((l) => ({
        id:              l.id,
        slug:            l.slug,
        url:             `${webBase}/checkout/${l.slug}`,
        amount:          l.amount,
        currency:        l.currency,
        description:     l.description,
        reference:       l.reference,
        provider:        l.provider,
        status:          l.status,
        attemptCount:    l.attemptCount,
        maxAttempts:     l.maxAttempts,
        expiresAt:       l.expiresAt,
        isRecurring:     l.isRecurring,
        billingInterval: l.billingInterval,
        intervalValue:   l.intervalValue,
        createdAt:       l.createdAt,
      })),
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
    });
  }),
);

// ─── GET /payment-links/:id ───────────────────────────────────────────────────────

router.get(
  '/:id',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: { _count: { select: { paymentIntents: true } } },
    });
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Payment link not found');

    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
    res.json({ ...link, url: `${webBase}/checkout/${link.slug}` });
  }),
);

// ─── PATCH /payment-links/:id/cancel ─────────────────────────────────────────────

router.patch(
  '/:id/cancel',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Payment link not found');
    if (link.status !== 'ACTIVE') {
      throw new AppError(400, 'LINK_NOT_ACTIVE', 'Only active links can be canceled');
    }

    const updated = await prisma.paymentLink.update({
      where: { id: link.id },
      data:  { status: 'CANCELED' },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.PAYMENT_LINK_CANCELED,
        entityType: 'PaymentLink',
        entityId:   link.id,
        ip:         req.ip,
      },
    });

    res.json({ id: updated.id, status: updated.status });
  }),
);

// ─── Public: GET /public/checkout/:slug ──────────────────────────────────────────
// No auth — used by the hosted checkout page.

export const publicCheckoutRouter = Router();

publicCheckoutRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where:   { slug: req.params.slug },
      include: { tenant: { select: { name: true, status: true } } },
    });

    if (!link) {
      throw new AppError(404, 'LINK_NOT_FOUND', 'Payment link not found');
    }
    if (link.tenant.status === 'DISABLED') {
      throw new AppError(403, 'TENANT_DISABLED', 'This merchant is not currently accepting payments');
    }
    if (link.status === 'CANCELED') {
      throw new AppError(410, 'LINK_CANCELED', 'This payment link has been canceled');
    }
    if (link.status === 'PAID') {
      throw new AppError(410, 'LINK_PAID', 'This payment link has already been paid');
    }
    if (link.status === 'EXPIRED' || (link.expiresAt && link.expiresAt < new Date())) {
      throw new AppError(410, 'LINK_EXPIRED', 'This payment link has expired');
    }

    res.json({
      slug:            link.slug,
      merchantName:    link.tenant.name,
      amount:          link.amount,
      currency:        link.currency,
      description:     link.description,
      reference:       link.reference,
      customerName:    link.customerName,
      customerEmail:   link.customerEmail,
      customerPhone:   link.customerPhone,
      provider:        link.provider,
      isRecurring:     link.isRecurring,
      billingInterval: link.billingInterval,
      intervalValue:   link.intervalValue,
    });
  }),
);

export default router;
