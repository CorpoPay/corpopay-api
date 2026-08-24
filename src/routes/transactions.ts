import { Router } from "express";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { centimes, centimesToMad } from "../lib/money";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";

const router = Router();

// ─── GET /transactions ────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const {
      page = "1",
      limit = "20",
      offset, // frontend paginates via offset; takes priority over page
      status,
      provider,
      search,
      dateFrom,
      dateTo,
    } = req.query as Record<string, string>;

    const take = parseInt(limit);
    const skip = offset !== undefined ? Math.max(0, parseInt(offset)) : (parseInt(page) - 1) * take;

    const db = forTenant(req.user!.tenantId);
    const where: Record<string, unknown> = {};
    if (status) where["status"] = status;
    if (provider) where["provider"] = provider;
    if (dateFrom || dateTo) {
      where["createdAt"] = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo) } : {}),
      };
    }
    if (search) {
      where["OR"] = [
        { correlationId: { contains: search, mode: "insensitive" } },
        { paymentLink: { reference: { contains: search, mode: "insensitive" } } },
        { paymentLink: { description: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [intents, total] = await Promise.all([
      db.paymentIntent.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: {
          paymentLink: {
            select: {
              slug: true,
              reference: true,
              amount: true,
              currency: true,
              description: true,
            },
          },
          providerTxs: {
            select: { providerTransactionId: true },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
          refunds: { select: { id: true, status: true, amount: true } },
        },
      }),
      db.paymentIntent.count({ where }),
    ]);

    res.json({
      data: intents.map((i) => {
        const meta = (i.metadata ?? {}) as Record<string, unknown>;
        // Direct intents (no paymentLink) store amount/currency/reference/description in metadata
        const amount =
          i.paymentLink?.amount ??
          (meta.amount != null ? centimesToMad(centimes(Number(meta.amount))) : null);
        const currency = i.paymentLink?.currency ?? (meta.currency as string) ?? null;
        const reference = i.paymentLink?.reference ?? (meta.reference as string) ?? null;
        const description = i.paymentLink?.description ?? (meta.description as string) ?? null;
        return {
          id: i.id,
          correlationId: i.correlationId,
          status: i.status,
          provider: i.provider,
          providerRef: i.providerRef,
          providerTransactionId: i.providerTxs[0]?.providerTransactionId ?? null,
          amount,
          currency,
          paymentLink: i.paymentLink
            ? {
                title: i.paymentLink.description ?? i.paymentLink.reference,
                slug: i.paymentLink.slug,
              }
            : null,
          reference,
          description,
          hasRefund: i.refunds.length > 0,
          refundStatus: i.refunds[0]?.status ?? null,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        };
      }),
      total,
      page: parseInt(page),
      limit: take,
    });
  }),
);

// ─── GET /transactions/:id ────────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const intent = await db.paymentIntent.findFirst({
      where: { id: req.params.id },
      include: {
        paymentLink: {
          select: {
            id: true,
            slug: true,
            amount: true,
            currency: true,
            description: true,
            reference: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            provider: true,
            status: true,
            createdAt: true,
          },
        },
        providerTxs: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            provider: true,
            providerTransactionId: true,
            rawResponse: true,
            createdAt: true,
          },
        },
        refunds: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            amount: true,
            currency: true,
            providerRefundRef: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        webhookEvents: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            provider: true,
            signatureVerified: true,
            processed: true,
            mappedStatus: true,
            processingError: true,
            createdAt: true,
          },
        },
      },
    });

    if (!intent) throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found");

    // Build a sorted timeline
    type TimelineEntry = { type: string; timestamp: Date; detail: string };
    const timeline: TimelineEntry[] = [
      { type: "INTENT_CREATED", timestamp: intent.createdAt, detail: "Payment intent created" },
    ];
    if (intent.status === "REQUIRES_ACTION" || intent.status === "PROCESSING") {
      timeline.push({
        type: "CHECKOUT_OPENED",
        timestamp: intent.updatedAt,
        detail: "Customer opened checkout",
      });
    }
    intent.webhookEvents.forEach((wh) => {
      timeline.push({
        type: "WEBHOOK_RECEIVED",
        timestamp: wh.createdAt,
        detail: `Webhook from ${wh.provider} – verified: ${wh.signatureVerified}, status: ${wh.mappedStatus ?? "unknown"}`,
      });
    });
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(intent.status)) {
      timeline.push({
        type: `PAYMENT_${intent.status}`,
        timestamp: intent.updatedAt,
        detail: `Payment ${intent.status.toLowerCase()}`,
      });
    }
    intent.refunds.forEach((r) => {
      timeline.push({
        type: "REFUND_INITIATED",
        timestamp: r.createdAt,
        detail: `Refund ${r.status}`,
      });
    });
    timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    res.json({
      ...intent,
      // Hoist amount/currency from paymentLink so the frontend can read them directly
      amount: intent.paymentLink?.amount ?? null,
      currency: intent.paymentLink?.currency ?? null,
      timeline,
    });
  }),
);

export default router;
