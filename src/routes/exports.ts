import { Router } from "express";
import { stringify } from "csv-stringify";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── GET /exports/transactions.csv ───────────────────────────────────────────────

router.get(
  "/transactions.csv",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const { dateFrom, dateTo, status, provider, search } = req.query as Record<string, string>;

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

    const intents = await db.paymentIntent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        paymentLink: {
          select: { reference: true, amount: true, currency: true, description: true },
        },
        providerTxs: {
          select: { providerTransactionId: true },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
        refunds: {
          select: { status: true, createdAt: true },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
    });

    const filename = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const csvStream = stringify({
      header: true,
      columns: [
        { key: "id", header: "Intent ID" },
        { key: "correlationId", header: "Correlation ID" },
        { key: "reference", header: "Reference" },
        { key: "amount", header: "Amount (MAD)" },
        { key: "currency", header: "Currency" },
        { key: "status", header: "Status" },
        { key: "provider", header: "Provider" },
        { key: "providerRef", header: "Provider Ref" },
        { key: "providerTransactionId", header: "Provider Tx ID" },
        { key: "refundStatus", header: "Refund Status" },
        { key: "refundedAt", header: "Refunded At" },
        { key: "createdAt", header: "Created At" },
        { key: "updatedAt", header: "Updated At" },
      ],
    });

    csvStream.pipe(res);

    for (const intent of intents) {
      csvStream.write({
        id: intent.id,
        correlationId: intent.correlationId,
        reference: intent.paymentLink?.reference ?? "",
        amount: intent.paymentLink?.amount.toString() ?? "",
        currency: intent.paymentLink?.currency ?? "",
        status: intent.status,
        provider: intent.provider,
        providerRef: intent.providerRef ?? "",
        providerTransactionId: intent.providerTxs[0]?.providerTransactionId ?? "",
        refundStatus: intent.refunds[0]?.status ?? "",
        refundedAt: intent.refunds[0]?.createdAt?.toISOString() ?? "",
        createdAt: intent.createdAt.toISOString(),
        updatedAt: intent.updatedAt.toISOString(),
      });
    }

    csvStream.end();
  }),
);

export default router;
