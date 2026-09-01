/**
 * Admin-only routes (Support Admin + Super Admin).
 * Mounted at /admin in app.ts.
 */
import { Router } from "express";
import { z } from "zod";
import { Provider } from "@/generated/prisma/client";
import type { VpsCredentials } from "../adapters/types";
import { VpsAdapter } from "../adapters/vps.adapter";
import { decryptCredentials } from "../lib/encryption";
import { madToCentimes } from "../lib/money";
import { markPayoutPaid } from "../lib/payout-db";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth, requireSuperAdmin } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { manualPayoutSchema, providerHealthSchema } from "../schemas/admin";

const router = Router();

// ─── GET /admin/payments/search ───────────────────────────────────────────────────

router.get(
  "/payments/search",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { q } = req.query as { q?: string };
    if (!q || q.trim().length < 2) {
      throw new AppError(400, "QUERY_TOO_SHORT", "Search query must be at least 2 characters");
    }

    const term = q.trim();

    // Search across multiple identifiers
    const [byId, byCorrelation, byProviderRef, byReference, bySlug] = await Promise.all([
      prisma.paymentIntent.findFirst({
        where: { id: term },
        include: {
          paymentLink: true,
          providerTxs: true,
          webhookEvents: { orderBy: { createdAt: "asc" } },
          refunds: true,
        },
      }),
      prisma.paymentIntent.findFirst({
        where: { correlationId: term },
        include: {
          paymentLink: true,
          providerTxs: true,
          webhookEvents: { orderBy: { createdAt: "asc" } },
          refunds: true,
        },
      }),
      prisma.paymentIntent.findFirst({
        where: { providerRef: term },
        include: {
          paymentLink: true,
          providerTxs: true,
          webhookEvents: { orderBy: { createdAt: "asc" } },
          refunds: true,
        },
      }),
      prisma.paymentIntent.findFirst({
        where: { paymentLink: { reference: term } },
        include: {
          paymentLink: true,
          providerTxs: true,
          webhookEvents: { orderBy: { createdAt: "asc" } },
          refunds: true,
        },
      }),
      prisma.paymentIntent.findFirst({
        where: { paymentLink: { slug: term } },
        include: {
          paymentLink: true,
          providerTxs: true,
          webhookEvents: { orderBy: { createdAt: "asc" } },
          refunds: true,
        },
      }),
    ]);

    // Also search by providerTransactionId
    const byProviderTxId = await (async () => {
      const ptx = await prisma.providerTransaction.findFirst({
        where: { providerTransactionId: term },
      });
      if (!ptx) return null;
      return prisma.paymentIntent.findFirst({
        where: { id: ptx.paymentIntentId },
        include: {
          paymentLink: true,
          providerTxs: true,
          webhookEvents: { orderBy: { createdAt: "asc" } },
          refunds: true,
        },
      });
    })();

    const result =
      byId ?? byCorrelation ?? byProviderRef ?? byReference ?? bySlug ?? byProviderTxId;

    if (!result) {
      return res.json({ found: false, intent: null });
    }

    return res.json({ found: true, intent: result });
  }),
);

// ─── GET /admin/webhooks ──────────────────────────────────────────────────────────

router.get(
  "/webhooks",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const {
      page = "1",
      limit = "20",
      provider,
      tenantId,
      verified,
      processed,
      dateFrom,
      dateTo,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: Record<string, unknown> = {};
    if (provider) where["provider"] = provider as Provider;
    if (tenantId) where["tenantId"] = tenantId;
    if (verified !== undefined) where["signatureVerified"] = verified === "true";
    if (processed !== undefined) where["processed"] = processed === "true";
    if (dateFrom || dateTo) {
      where["createdAt"] = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo) } : {}),
      };
    }

    const [events, total] = await Promise.all([
      prisma.webhookEvent.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          provider: true,
          tenantId: true,
          paymentIntentId: true,
          signatureVerified: true,
          processed: true,
          processingError: true,
          mappedStatus: true,
          idempotencyKey: true,
          createdAt: true,
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
  "/provider-health",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const health = await prisma.providerHealth.findMany();
    // Ensure both providers appear even if no record exists yet
    const result = [Provider.NAPS, Provider.VPS].map((p) => {
      const record = health.find((h) => h.provider === p);
      return record ?? { provider: p, status: "NORMAL", notes: null, updatedAt: null };
    });
    res.json(result);
  }),
);

// ─── PUT /admin/provider-health/:provider ─────────────────────────────────────────

router.put(
  "/provider-health/:provider",
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const provider = z.enum(["NAPS", "VPS"]).parse(req.params.provider) as Provider;
    const { status, notes } = providerHealthSchema.parse(req.body);

    const record = await prisma.providerHealth.upsert({
      where: { provider },
      create: { provider, status, notes },
      update: { status, notes },
    });

    res.json(record);
  }),
);

// ─── POST /admin/payouts/:id/execute ────────────────────────────────────────
// Manual-payout execution (Morocco model): VPS/Payzone settles gross but has no
// disbursement API, so a CorpoPay admin performs the bank transfer out-of-band
// and records it here. Marks the payout PAID and posts the AVAILABLE → PAID_OUT
// ledger movement WITHOUT calling any provider.

router.post(
  "/payouts/:id/execute",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { externalReference } = manualPayoutSchema.parse(req.body);

    const payout = await prisma.payout.findUnique({ where: { id: req.params.id } });
    if (!payout) throw new AppError(404, "PAYOUT_NOT_FOUND", "Payout not found");
    if (payout.status === "PAID") {
      throw new AppError(409, "PAYOUT_ALREADY_PAID", "Payout already paid");
    }

    const updated = await markPayoutPaid(payout.tenantId, payout.id, externalReference);
    res.json({
      id: updated.id,
      status: updated.status,
      providerTransferId: updated.providerTransferId,
      externalReference,
    });
  }),
);

// ─── Admin settlement read surface (cross-tenant) ───────────────────────────────

/** Shared list pagination: page/limit from query, bounded and 1-indexed. */
function parseAdminPagination(req: { query: Record<string, unknown> }) {
  const { page = "1", limit = "20" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { skip: (pageNum - 1) * limitNum, take: limitNum, page: pageNum, limit: limitNum };
}

// GET /admin/payouts — cross-tenant payout list (the manual-payout review queue).
router.get(
  "/payouts",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: string };
    const { skip, take, page, limit } = parseAdminPagination(req);
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    const [rows, total] = await Promise.all([
      prisma.payout.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { tenant: { select: { name: true, slug: true } }, items: true },
      }),
      prisma.payout.count({ where }),
    ]);
    res.json({
      data: rows.map((p) => ({
        id: p.id,
        tenantId: p.tenantId,
        tenantName: p.tenant.name,
        tenantSlug: p.tenant.slug,
        status: p.status,
        provider: p.provider,
        method: p.method,
        currency: p.currency,
        amountCents: madToCentimes(p.amount),
        feeCents: madToCentimes(p.feeAmount),
        providerTransferId: p.providerTransferId,
        idempotencyKey: p.idempotencyKey,
        items: p.items.map((item) => ({
          id: item.id,
          ledgerEntryId: item.ledgerEntryId,
          amountCents: madToCentimes(item.amount),
        })),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      total,
      page,
      limit,
    });
  }),
);

// GET /admin/onboarding — cross-tenant onboarding review queue.
router.get(
  "/onboarding",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: string };
    const { skip, take, page, limit } = parseAdminPagination(req);
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    const [rows, total] = await Promise.all([
      prisma.merchantOnboarding.findMany({
        where,
        skip,
        take,
        orderBy: { updatedAt: "desc" },
        include: { tenant: { select: { name: true, slug: true } } },
      }),
      prisma.merchantOnboarding.count({ where }),
    ]);
    res.json({
      data: rows.map((o) => ({
        id: o.id,
        tenantId: o.tenantId,
        tenantName: o.tenant.name,
        tenantSlug: o.tenant.slug,
        status: o.status,
        legalName: o.legalName,
        entityType: o.entityType,
        registrationNumber: o.registrationNumber,
        country: o.country,
        businessAddress: o.businessAddress,
        website: o.website,
        contactEmail: o.contactEmail,
        industry: o.industry,
        mcc: o.mcc,
        riskTier: o.riskTier,
        submittedAt: o.submittedAt,
        reviewerId: o.reviewerId,
        reviewNotes: o.reviewNotes,
        rejectionReason: o.rejectionReason,
        approvedAt: o.approvedAt,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })),
      total,
      page,
      limit,
    });
  }),
);

// GET /admin/disputes — cross-tenant dispute list.
router.get(
  "/disputes",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: string };
    const { skip, take, page, limit } = parseAdminPagination(req);
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    const [rows, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { tenant: { select: { name: true, slug: true } }, recovery: true },
      }),
      prisma.dispute.count({ where }),
    ]);
    res.json({
      data: rows.map((d) => ({
        id: d.id,
        tenantId: d.tenantId,
        tenantName: d.tenant.name,
        tenantSlug: d.tenant.slug,
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
      })),
      total,
      page,
      limit,
    });
  }),
);

// GET /admin/reconciliation-reports — cross-tenant reconciliation list.
router.get(
  "/reconciliation-reports",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: string };
    const { skip, take, page, limit } = parseAdminPagination(req);
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    const [rows, total] = await Promise.all([
      prisma.reconciliationReport.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { tenant: { select: { name: true, slug: true } }, lines: true },
      }),
      prisma.reconciliationReport.count({ where }),
    ]);
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        tenantSlug: r.tenant.slug,
        provider: r.provider,
        currency: r.currency,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        status: r.status,
        summary: r.summary,
        lineCount: r.lines.length,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
      page,
      limit,
    });
  }),
);

// GET /admin/settlement-statements — cross-tenant statements list.
router.get(
  "/settlement-statements",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: string };
    const { skip, take, page, limit } = parseAdminPagination(req);
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    const [rows, total] = await Promise.all([
      prisma.settlementStatement.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { tenant: { select: { name: true, slug: true } }, items: true },
      }),
      prisma.settlementStatement.count({ where }),
    ]);
    res.json({
      data: rows.map((s) => ({
        id: s.id,
        tenantId: s.tenantId,
        tenantName: s.tenant.name,
        tenantSlug: s.tenant.slug,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        currency: s.currency,
        status: s.status,
        openingBalanceCents: madToCentimes(s.openingBalance),
        closingBalanceCents: madToCentimes(s.closingBalance),
        netCents: madToCentimes(s.netAmount),
        finalizedAt: s.finalizedAt,
        itemCount: s.items.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      total,
      page,
      limit,
    });
  }),
);

// ─── GET /admin/vps-tenants ─────────────────────────────────────────────────────
// Returns the minimal list of tenants that have a CONNECTED VPS config so the
// UI can populate a tenant picker before running the recurring billing test.

router.get(
  "/vps-tenants",
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const configs = await prisma.providerConfig.findMany({
      where: { provider: "VPS", status: "CONNECTED" },
      include: { tenant: { select: { id: true, name: true } } },
    });

    const tenants = configs.map((c) => ({
      id: c.tenantId,
      name: (c as any).tenant?.name ?? c.tenantId,
    }));

    return res.json(tenants);
  }),
);

// ─── POST /admin/recurring-test ────────────────────────────────────────────────
//
// Sanity-checks every tenant's VPS recurring billing readiness WITHOUT
// triggering any real charges:
//   1. Decrypts VPS credentials and calls testConnection() (hits a dummy charge
//      endpoint — Payzone returns 404 for an unknown charge, which confirms
//      the API is reachable and the credentials are valid).
//   2. Verifies showPaymentProfiles is not explicitly disabled.
//   3. Reads live subscription stats per tenant (active / pastDue / pending /
//      cancelled in last 30 days).
//   4. Counts subscriptions due for billing in the next 24 h.
//
// Returns a single JSON report so the UI can show a per-tenant traffic light.

router.post(
  "/recurring-test",
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const testedAt = new Date();

    // Optional: scope test to a single tenant
    const { tenantId: filterTenantId } = req.body as { tenantId?: string };

    // 1. Load active VPS provider configs (optionally scoped to one tenant)
    const configs = await prisma.providerConfig.findMany({
      where: {
        provider: "VPS",
        status: "CONNECTED",
        ...(filterTenantId ? { tenantId: filterTenantId } : {}),
      },
      include: { tenant: { select: { id: true, name: true } } },
    });

    // 2. For each config run the checks
    const tenantResults = await Promise.all(
      configs.map(async (cfg) => {
        const tenantId = cfg.tenantId;
        const tenantName = (cfg as any).tenant?.name ?? tenantId;

        // ── a. VPS connectivity + credential check (isolated try/catch) ──────────
        let connected = false;
        let profileStorageEnabled = false;
        let vpsError: string | undefined;
        let latencyMs = 0;

        try {
          const creds = decryptCredentials<VpsCredentials>(cfg.encryptedCredentials);
          const adapter = new VpsAdapter(creds);
          const t0 = Date.now();
          const result = await adapter.testConnection();
          latencyMs = Date.now() - t0;
          connected = result.connected;
          vpsError = result.error;
          // showPaymentProfiles must not be 'false'; undefined/missing → default OK
          profileStorageEnabled = (creds.showPaymentProfiles ?? "true") !== "false";
        } catch (err: unknown) {
          vpsError = (err as Error).message;
        }

        // ── b. Subscription stats (separate try/catch — table may not exist yet) ─
        let subscriptionStats = {
          active: 0,
          pastDue: 0,
          pending: 0,
          cancelledLast30d: 0,
          billingEventsTotal: 0,
        };
        let dueTodayCount = 0;
        let dbError: string | undefined;

        try {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const now24h = new Date(Date.now() + 24 * 60 * 60 * 1000);

          const [active, pastDue, pending, cancelledLast30d, dueToday, billingEventsTotal] =
            await Promise.all([
              prisma.subscription.count({ where: { tenantId, status: "ACTIVE" } }),
              prisma.subscription.count({ where: { tenantId, status: "PAST_DUE" } }),
              prisma.subscription.count({ where: { tenantId, status: "PENDING" } }),
              prisma.subscription.count({
                where: { tenantId, status: "CANCELLED", updatedAt: { gte: thirtyDaysAgo } },
              }),
              prisma.subscription.count({
                where: {
                  tenantId,
                  status: { in: ["ACTIVE", "PAST_DUE"] },
                  nextBillingDate: { lte: now24h },
                },
              }),
              prisma.billingEvent.count({
                where: { subscription: { tenantId } },
              }),
            ]);

          subscriptionStats = { active, pastDue, pending, cancelledLast30d, billingEventsTotal };
          dueTodayCount = dueToday;
        } catch (err: unknown) {
          // Gracefully handle missing table (migration not yet applied on this instance)
          const msg = (err as Error).message ?? "";
          dbError = msg.includes("does not exist")
            ? "Subscriptions table not found — run `prisma migrate deploy` on this instance"
            : msg;
        }

        return {
          tenantId,
          tenantName,
          checks: {
            connectivity: connected,
            profileStorage: profileStorageEnabled,
            hasActiveSubscriptions: subscriptionStats.active > 0,
            migrationApplied: !dbError,
          },
          latencyMs,
          vpsError,
          dbError,
          subscriptionStats,
          dueTodayCount,
        };
      }),
    );

    // 3. Derive overall status
    // Use explicit === false checks so that any field being undefined (e.g.
    // from a response cached before the field was added) doesn't count as a
    // failure — only an explicit false value does.
    const allConnected = tenantResults.every((t) => t.checks.connectivity === true);
    const anyError = tenantResults.some(
      (t) =>
        t.checks.connectivity === false ||
        t.checks.profileStorage === false ||
        t.checks.migrationApplied === false,
    );
    const overallStatus =
      configs.length === 0
        ? "NO_VPS_CONFIGS"
        : !anyError
          ? "OK"
          : allConnected
            ? "PARTIAL"
            : "FAILING";

    return res.json({
      testedAt,
      overallStatus,
      totalVpsConfigs: configs.length,
      tenants: tenantResults,
    });
  }),
);

export default router;
