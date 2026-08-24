import { Router } from "express";
import { BillingInterval, Provider } from "@/generated/prisma/client";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { centimes, centimesToMad } from "../lib/money";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import { AuditAction } from "@/generated/prisma/client";
import { createPaymentLinkSchema } from "../schemas/payment-links";
import { trackMetric } from "../lib/metrics";

const router = Router();

// ─── POST /payment-links ──────────────────────────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const data = createPaymentLinkSchema.parse(req.body);

    // Verify tenant has provider configured
    const db = forTenant(req.user!.tenantId);
    const providerConfig = await db.providerConfig.findFirst({
      where: {
        provider: data.provider as Provider,
        status: "CONNECTED",
      },
    });
    if (!providerConfig) {
      throw new AppError(
        400,
        "PROVIDER_NOT_CONFIGURED",
        `Provider ${data.provider} is not configured or not connected`,
      );
    }

    const link = await prisma.paymentLink.create({
      data: {
        tenantId: req.user!.tenantId,
        amount: centimesToMad(centimes(data.amount)), // store as MAD decimal
        currency: data.currency,
        description: data.description,
        reference: data.reference,
        provider: data.provider as Provider,
        customerName: data.customerName,
        customerEmail: data.customerEmail || undefined,
        customerPhone: data.customerPhone,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        maxAttempts: data.maxAttempts,
        isRecurring: data.isRecurring,
        billingInterval: data.billingInterval ?? null,
        intervalValue: data.intervalValue,
        maxRetries: data.maxRetries,
        isInstallment: data.isInstallment,
      },
    });

    trackMetric("corpopay.payment_link.created", 1, [
      `provider:${data.provider}`,
      `currency:${data.currency}`,
      `recurring:${data.isRecurring}`,
      `installment:${data.isInstallment}`,
    ]);

    const webBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";
    const checkoutUrl = `${webBase}/checkout/${link.slug}`;

    res.status(201).json({
      id: link.id,
      slug: link.slug,
      url: checkoutUrl,
      amount: link.amount,
      currency: link.currency,
      description: link.description,
      reference: link.reference,
      status: link.status,
      isRecurring: link.isRecurring,
      billingInterval: link.billingInterval,
      intervalValue: link.intervalValue,
      createdAt: link.createdAt,
    });
  }),
);

// ─── GET /payment-links ───────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const { page = "1", limit = "20", offset, status } = req.query as Record<string, string>;

    const skip =
      offset !== undefined ? Math.max(0, parseInt(offset)) : (parseInt(page) - 1) * parseInt(limit);

    const db = forTenant(req.user!.tenantId);
    const [links, total] = await Promise.all([
      db.paymentLink.findMany({
        where: {
          ...(status ? { status: status as any } : {}),
        },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { paymentIntents: true } } },
      }),
      db.paymentLink.count({
        where: {
          ...(status ? { status: status as any } : {}),
        },
      }),
    ]);

    const webBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";

    res.json({
      data: links.map((l) => ({
        id: l.id,
        slug: l.slug,
        url: `${webBase}/checkout/${l.slug}`,
        amount: l.amount,
        currency: l.currency,
        description: l.description,
        reference: l.reference,
        provider: l.provider,
        status: l.status,
        attemptCount: l.attemptCount,
        maxAttempts: l.maxAttempts,
        expiresAt: l.expiresAt,
        isRecurring: l.isRecurring,
        billingInterval: l.billingInterval,
        intervalValue: l.intervalValue,
        createdAt: l.createdAt,
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  }),
);

// ─── GET /payment-links/:id ───────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const link = await db.paymentLink.findFirst({
      where: { id: req.params.id },
      include: { _count: { select: { paymentIntents: true } } },
    });
    if (!link) throw new AppError(404, "LINK_NOT_FOUND", "Payment link not found");

    const webBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";
    res.json({ ...link, url: `${webBase}/checkout/${link.slug}` });
  }),
);

// ─── PATCH /payment-links/:id/cancel ─────────────────────────────────────────────

router.patch(
  "/:id/cancel",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const link = await db.paymentLink.findFirst({
      where: { id: req.params.id },
    });
    if (!link) throw new AppError(404, "LINK_NOT_FOUND", "Payment link not found");
    if (link.status !== "ACTIVE") {
      throw new AppError(400, "LINK_NOT_ACTIVE", "Only active links can be canceled");
    }

    const updated = await prisma.paymentLink.update({
      where: { id: link.id },
      data: { status: "CANCELED" },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.PAYMENT_LINK_CANCELED,
        entityType: "PaymentLink",
        entityId: link.id,
        ip: req.ip,
      },
    });

    res.json({ id: updated.id, status: updated.status });
  }),
);

// ─── Public: GET /public/checkout/:slug ──────────────────────────────────────────
// No auth — used by the hosted checkout page.

export const publicCheckoutRouter = Router();

publicCheckoutRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where: { slug: req.params.slug },
      include: { tenant: { select: { name: true, status: true } } },
    });

    if (!link) {
      throw new AppError(404, "LINK_NOT_FOUND", "Payment link not found");
    }
    if (link.tenant.status === "DISABLED") {
      throw new AppError(
        403,
        "TENANT_DISABLED",
        "This merchant is not currently accepting payments",
      );
    }
    if (link.status === "CANCELED") {
      throw new AppError(410, "LINK_CANCELED", "This payment link has been canceled");
    }
    if (link.status === "PAID") {
      throw new AppError(410, "LINK_PAID", "This payment link has already been paid");
    }
    if (link.status === "EXPIRED" || (link.expiresAt && link.expiresAt < new Date())) {
      throw new AppError(410, "LINK_EXPIRED", "This payment link has expired");
    }

    res.json({
      slug: link.slug,
      merchantName: link.tenant.name,
      amount: link.amount,
      currency: link.currency,
      description: link.description,
      // M-8: reference is an internal merchant identifier — not exposed to customers
      customerName: link.customerName,
      customerEmail: link.customerEmail,
      customerPhone: link.customerPhone,
      provider: link.provider,
      isRecurring: link.isRecurring,
      isInstallment: link.isInstallment,
      billingInterval: link.billingInterval,
      intervalValue: link.intervalValue,
    });
  }),
);

export default router;
