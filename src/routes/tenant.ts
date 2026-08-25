import { Router } from "express";
import { AuditAction } from "@/generated/prisma/client";
import { prisma } from "../lib/prisma";
import {
  requireAdmin,
  requireAuth,
  requireMerchant,
  requireOwner,
  requireSuperAdmin,
} from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { tenantStatusSchema } from "../schemas/admin";
import { updateTenantSchema } from "../schemas/tenant";

const router = Router();

// ─── GET /tenant ─ own tenant profile ────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user!.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        environment: true,
        createdAt: true,
        notifyWebhookUrl: true,
        notifyEmail: true,
      },
    });
    if (!tenant) throw new AppError(404, "TENANT_NOT_FOUND", "Tenant not found");
    res.json(tenant);
  }),
);

// ─── PATCH /tenant ──────────────────────────────────────────────────────────────

router.patch(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const data = updateTenantSchema.parse(req.body);
    const tenant = await prisma.tenant.update({
      where: { id: req.user!.tenantId },
      data,
    });
    res.json({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      notifyWebhookUrl: tenant.notifyWebhookUrl,
      notifyEmail: tenant.notifyEmail,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════════
// ADMIN routes — mounted at /admin/tenants in app.ts
// ═══════════════════════════════════════════════════════════════════════════════════

export const adminTenantRouter = Router();

// GET /admin/tenants
adminTenantRouter.get(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page = "1", limit = "20", status } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where: status ? { status: status as any } : undefined,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { paymentIntents: true } },
          providerConfigs: { select: { provider: true, status: true } },
        },
      }),
      prisma.tenant.count({ where: status ? { status: status as any } : undefined }),
    ]);

    // Get last transaction date per tenant
    const tenantIds = tenants.map((t) => t.id);
    const lastIntents = await prisma.paymentIntent.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { tenantId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      distinct: ["tenantId"],
    });
    const lastTxMap = Object.fromEntries(lastIntents.map((i) => [i.tenantId, i.createdAt]));

    const result = tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      environment: t.environment,
      createdAt: t.createdAt,
      transactionCount: t._count.paymentIntents,
      providerConfigs: t.providerConfigs,
      lastTransactionAt: lastTxMap[t.id] ?? null,
    }));

    res.json({ data: result, total, page: parseInt(page), limit: parseInt(limit) });
  }),
);

// GET /admin/tenants/:id
adminTenantRouter.get(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        users: { select: { id: true, email: true, role: true, createdAt: true } },
        providerConfigs: {
          select: {
            id: true,
            provider: true,
            status: true,
            environment: true,
            updatedAt: true,
            // Never return encryptedCredentials to admin UI
          },
        },
      },
    });
    if (!tenant) throw new AppError(404, "TENANT_NOT_FOUND", "Tenant not found");
    res.json(tenant);
  }),
);

// PATCH /admin/tenants/:id/status
adminTenantRouter.patch(
  "/:id/status",
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { status } = tenantStatusSchema.parse(req.body);

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: { status },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: req.user!.id,
        action: status === "ACTIVE" ? AuditAction.TENANT_ENABLED : AuditAction.TENANT_DISABLED,
        entityType: "Tenant",
        entityId: tenant.id,
        ip: req.ip,
      },
    });

    res.json({ id: tenant.id, status: tenant.status });
  }),
);

export default router;
