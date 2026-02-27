import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant, requireOwner, requireAdmin, requireSuperAdmin } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuditAction } from '@prisma/client';

const router = Router();

// SSRF guard — reuse same logic as paymentIntents.ts
function safeUrl(val: string): boolean {
  try {
    const u = new URL(val);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch { return false; }
}
const SafeUrl = z.string().url().refine(safeUrl, { message: 'URL must be HTTPS and not a private/loopback address' });

// ─── GET /tenant ─ own tenant profile ────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where:  { id: req.user!.tenantId },
      select: { id: true, name: true, slug: true, status: true, environment: true, createdAt: true, notifyWebhookUrl: true, notifyEmail: true },
    });
    if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    res.json(tenant);
  }),
);

// ─── PATCH /tenant ──────────────────────────────────────────────────────────────

const UpdateTenantSchema = z.object({
  name:             z.string().min(2).max(100).optional(),
  notifyWebhookUrl: SafeUrl.nullable().optional(),   // outbound webhook URL for payment events
  notifyEmail:      z.string().email().nullable().optional(),
});

router.patch(
  '/',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const data = UpdateTenantSchema.parse(req.body);
    const tenant = await prisma.tenant.update({
      where: { id: req.user!.tenantId },
      data,
    });
    res.json({
      id:               tenant.id,
      name:             tenant.name,
      slug:             tenant.slug,
      notifyWebhookUrl: tenant.notifyWebhookUrl,
      notifyEmail:      tenant.notifyEmail,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════════
// ADMIN routes — mounted at /admin/tenants in app.ts
// ═══════════════════════════════════════════════════════════════════════════════════

export const adminTenantRouter = Router();

// GET /admin/tenants
adminTenantRouter.get(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page = '1', limit = '20', status } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where:   status ? { status: status as any } : undefined,
        skip,
        take:    parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          _count:         { select: { paymentIntents: true } },
          providerConfigs: { select: { provider: true, status: true } },
        },
      }),
      prisma.tenant.count({ where: status ? { status: status as any } : undefined }),
    ]);

    // Get last transaction date per tenant
    const tenantIds = tenants.map((t) => t.id);
    const lastIntents = await prisma.paymentIntent.findMany({
      where:    { tenantId: { in: tenantIds } },
      select:   { tenantId: true, createdAt: true },
      orderBy:  { createdAt: 'desc' },
      distinct: ['tenantId'],
    });
    const lastTxMap = Object.fromEntries(lastIntents.map((i) => [i.tenantId, i.createdAt]));

    const result = tenants.map((t) => ({
      id:                t.id,
      name:              t.name,
      slug:              t.slug,
      status:            t.status,
      environment:       t.environment,
      createdAt:         t.createdAt,
      transactionCount:  t._count.paymentIntents,
      providerConfigs:   t.providerConfigs,
      lastTransactionAt: lastTxMap[t.id] ?? null,
    }));

    res.json({ data: result, total, page: parseInt(page), limit: parseInt(limit) });
  }),
);

// GET /admin/tenants/:id
adminTenantRouter.get(
  '/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where:   { id: req.params.id },
      include: {
        users: { select: { id: true, email: true, role: true, createdAt: true } },
        providerConfigs: {
          select: {
            id: true, provider: true, status: true, environment: true, updatedAt: true,
            // Never return encryptedCredentials to admin UI
          },
        },
      },
    });
    if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    res.json(tenant);
  }),
);

// PATCH /admin/tenants/:id/status
adminTenantRouter.patch(
  '/:id/status',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { status } = z
      .object({ status: z.enum(['ACTIVE', 'DISABLED']) })
      .parse(req.body);

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data:  { status },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   tenant.id,
        userId:     req.user!.id,
        action:     status === 'ACTIVE' ? AuditAction.TENANT_ENABLED : AuditAction.TENANT_DISABLED,
        entityType: 'Tenant',
        entityId:   tenant.id,
        ip:         req.ip,
      },
    });

    res.json({ id: tenant.id, status: tenant.status });
  }),
);

export default router;
