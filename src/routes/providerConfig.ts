import { Router } from 'express';
import { z } from 'zod';
import { Provider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireOwner, requireAdmin } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { encryptCredentials, decryptCredentials } from '../lib/encryption';
import { getAdapter } from '../adapters/registry';
import { AuditAction } from '@prisma/client';

const router = Router();

// Schemas per provider
const NapsCredentialsSchema = z.object({
  merchantId: z.string().min(1),
  terminalId: z.string().min(1),
  secretKey:  z.string().min(1),
  baseUrl:    z.string().url(),
});

const VpsCredentialsSchema = z.object({
  merchantCode: z.string().min(1),
  apiKey:       z.string().min(1),
  baseUrl:      z.string().url(),
});

const ProviderParamSchema = z.enum(['NAPS', 'VPS']);

function maskCredentials(creds: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (['secretKey', 'apiKey', 'password', 'token'].includes(k)) {
      masked[k] = typeof v === 'string' && v.length > 4
        ? `${(v as string).slice(0, 4)}${'*'.repeat(Math.max((v as string).length - 4, 4))}`
        : '****';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

// ─── GET /provider-configs ────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const configs = await prisma.providerConfig.findMany({
      where:  { tenantId: req.user!.tenantId },
      select: {
        id: true, provider: true, status: true,
        environment: true, createdAt: true, updatedAt: true,
        encryptedCredentials: true,
      },
    });

    const result = configs.map((c) => {
      let maskedCredentials: Record<string, unknown> = {};
      try {
        maskedCredentials = maskCredentials(decryptCredentials(c.encryptedCredentials));
      } catch { /* ignore decryption errors */ }
      return {
        id:          c.id,
        provider:    c.provider,
        status:      c.status,
        environment: c.environment,
        createdAt:   c.createdAt,
        updatedAt:   c.updatedAt,
        credentials: maskedCredentials,
      };
    });

    res.json(result);
  }),
);

// ─── POST /provider-configs ──────────────────────────────────────────────────────
// Upsert: provider + environment + credentials all come from the request body.

router.post(
  '/',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const provider = ProviderParamSchema.parse(req.body.provider) as Provider;

    const rawCredentials = req.body.credentials ?? req.body;
    let credentials: Record<string, unknown>;
    if (provider === Provider.NAPS) {
      credentials = NapsCredentialsSchema.parse(rawCredentials);
    } else {
      credentials = VpsCredentialsSchema.parse(rawCredentials);
    }

    const encrypted = encryptCredentials(credentials);
    const environment = req.body.environment ?? 'SANDBOX';

    const existing = await prisma.providerConfig.findFirst({
      where: { tenantId: req.user!.tenantId, provider },
    });

    const config = existing
      ? await prisma.providerConfig.update({
          where: { id: existing.id },
          data:  { encryptedCredentials: encrypted, environment, status: 'MISSING' },
        })
      : await prisma.providerConfig.create({
          data: {
            tenantId: req.user!.tenantId,
            provider,
            encryptedCredentials: encrypted,
            environment,
          },
        });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     existing ? AuditAction.PROVIDER_CONFIG_UPDATED : AuditAction.PROVIDER_CONFIG_CREATED,
        entityType: 'ProviderConfig',
        entityId:   config.id,
        metadata:   { provider },
        ip:         req.ip,
      },
    });

    res.json({ id: config.id, provider: config.provider, status: config.status });
  }),
);

// ─── POST /provider-configs/:id/test ─────────────────────────────────────────────

router.post(
  '/:id/test',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const config = await prisma.providerConfig.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!config) throw new AppError(404, 'CONFIG_NOT_FOUND', 'Provider config not found');

    const adapter = getAdapter(config.provider, config.encryptedCredentials);
    const result = await adapter.testConnection();

    const newStatus = result.connected ? 'CONNECTED' : 'INVALID';
    await prisma.providerConfig.update({
      where: { id: config.id },
      data:  { status: newStatus },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.PROVIDER_CONFIG_VALIDATED,
        entityType: 'ProviderConfig',
        entityId:   config.id,
        metadata:   { provider: config.provider, result } as any,
        ip:         req.ip,
      },
    });

    res.json({ connected: result.connected, status: newStatus, error: result.error });
  }),
);

// ─── DELETE /provider-configs/:id ────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const config = await prisma.providerConfig.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!config) throw new AppError(404, 'CONFIG_NOT_FOUND', 'Provider config not found');

    await prisma.providerConfig.delete({ where: { id: config.id } });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.PROVIDER_CONFIG_DELETED,
        entityType: 'ProviderConfig',
        entityId:   config.id,
        metadata:   { provider: config.provider },
        ip:         req.ip,
      },
    });

    res.status(204).send();
  }),
);

// ─── Admin: GET /admin/tenants/:id/provider-configs ───────────────────────────────

export const adminProviderConfigRouter = Router({ mergeParams: true });

adminProviderConfigRouter.get(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const configs = await prisma.providerConfig.findMany({
      where:  { tenantId: req.params.id },
      select: {
        id: true, provider: true, status: true,
        environment: true, createdAt: true, updatedAt: true,
        encryptedCredentials: true,
      },
    });

    const result = configs.map((c) => {
      let maskedCredentials: Record<string, unknown> = {};
      try {
        maskedCredentials = maskCredentials(decryptCredentials(c.encryptedCredentials));
      } catch { /* ignore */ }
      return { id: c.id, provider: c.provider, status: c.status, environment: c.environment, credentials: maskedCredentials };
    });

    res.json(result);
  }),
);

export default router;
