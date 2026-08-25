import { Router } from "express";
import { z } from "zod";
import { AuditAction, Provider, ProviderConfigStatus } from "@/generated/prisma/client";
import { getAdapter } from "../adapters/registry";
import { decryptCredentials, encryptCredentials } from "../lib/encryption";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAdmin, requireAuth, requireOwner, requireSuperAdmin } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import {
  napsCredentialsSchema,
  providerConfigStatusSchema,
  stripeCredentialsSchema,
  vpsCredentialsSchema,
} from "../schemas/provider-config";

const router = Router();

// Schemas per provider
const ProviderParamSchema = z.enum(["NAPS", "VPS", "STRIPE"]);

function maskCredentials(creds: Record<string, unknown>): Record<string, unknown> {
  // H-4: Expanded mask list — covers all VPS/NAPS/Stripe secret fields.
  // Any change here should be reflected in the credentials interfaces.
  const SENSITIVE = new Set([
    "secretKey",
    "apiKey",
    "password",
    "token",
    "paywallSecretKey",
    "callerPassword",
    "notificationKey", // VPS
    "webhookSecret", // Stripe
  ]);
  const masked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (SENSITIVE.has(k)) {
      masked[k] =
        typeof v === "string" && v.length > 4
          ? `${(v as string).slice(0, 4)}${"*".repeat(Math.max((v as string).length - 4, 4))}`
          : "****";
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

// ─── GET /provider-configs ────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const configs = await db.providerConfig.findMany({
      where: {},
      select: {
        id: true,
        provider: true,
        status: true,
        environment: true,
        createdAt: true,
        updatedAt: true,
        encryptedCredentials: true,
      },
    });

    const result = configs.map((c) => {
      let maskedCredentials: Record<string, unknown> = {};
      try {
        maskedCredentials = maskCredentials(decryptCredentials(c.encryptedCredentials));
      } catch {
        /* ignore decryption errors */
      }
      return {
        id: c.id,
        provider: c.provider,
        status: c.status,
        environment: c.environment,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        credentials: maskedCredentials,
      };
    });

    res.json(result);
  }),
);

// ─── POST /provider-configs ──────────────────────────────────────────────────────
// Upsert: provider + environment + credentials all come from the request body.

router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const provider = ProviderParamSchema.parse(req.body.provider) as Provider;

    const rawCredentials = req.body.credentials ?? req.body;
    let credentials: Record<string, unknown>;
    if (provider === Provider.NAPS) {
      credentials = napsCredentialsSchema.parse(rawCredentials);
    } else if (provider === Provider.STRIPE) {
      credentials = stripeCredentialsSchema.parse(rawCredentials);
    } else {
      credentials = vpsCredentialsSchema.parse(rawCredentials);
    }

    const environment = req.body.environment ?? "SANDBOX";

    // C-7: Reject callbackTestMode:true in production — it bypasses all webhook
    // signature verification, meaning any HTTP POST becomes a valid payment event.
    if (
      environment === "PRODUCTION" &&
      provider === Provider.VPS &&
      (credentials as any).callbackTestMode === true
    ) {
      throw new AppError(
        400,
        "UNSAFE_TEST_CONFIG",
        "callbackTestMode must not be enabled in production — it disables webhook signature verification",
      );
    }

    const encrypted = encryptCredentials(credentials);

    // H-8: Use upsert to avoid the race condition where two concurrent POSTs
    // both see no existing config and both try to INSERT, causing P2002.
    // Preserve DISABLED status on credential update — re-enabling must be
    // an explicit action via PATCH /:id/status, not a side-effect of saving
    // new credentials.
    const existing = await prisma.providerConfig.findUnique({
      where: { tenantId_provider: { tenantId: req.user!.tenantId, provider } },
      select: { status: true },
    });
    const updateStatus =
      existing?.status === "DISABLED"
        ? ProviderConfigStatus.DISABLED
        : ProviderConfigStatus.MISSING; // requires re-test after credential change

    const config = await prisma.providerConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user!.tenantId, provider } },
      create: {
        tenantId: req.user!.tenantId,
        provider,
        encryptedCredentials: encrypted,
        environment,
      },
      update: {
        encryptedCredentials: encrypted,
        environment,
        status: updateStatus,
      },
    });
    const isNew = config.createdAt.getTime() === config.updatedAt.getTime();

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: isNew ? AuditAction.PROVIDER_CONFIG_CREATED : AuditAction.PROVIDER_CONFIG_UPDATED,
        entityType: "ProviderConfig",
        entityId: config.id,
        metadata: { provider },
        ip: req.ip,
      },
    });

    // M-9: Warn when notificationKey / webhookSecret is absent — webhooks will be silently rejected
    const warnings: string[] = [];
    if (provider === Provider.VPS && !(credentials as any).notificationKey) {
      warnings.push(
        "notificationKey is not set: inbound Payzone webhooks will be rejected. Set it to enable payment confirmation callbacks.",
      );
    }
    if (provider === Provider.STRIPE && !(credentials as any).webhookSecret) {
      warnings.push(
        "webhookSecret is not set: inbound Stripe webhooks will be rejected. Retrieve it from the Stripe Dashboard → Webhooks.",
      );
    }

    res.json({
      id: config.id,
      provider: config.provider,
      status: config.status,
      warnings,
    });
  }),
);

// ─── PATCH /provider-configs/:id/status ──────────────────────────────────────────
// Enable or disable a provider config without deleting it.
// Only OWNER may toggle; DISABLED configs are blocked from processing payments.

router.patch(
  "/:id/status",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { enabled } = providerConfigStatusSchema.parse(req.body);

    const db = forTenant(req.user!.tenantId);
    const config = await db.providerConfig.findFirst({
      where: { id: req.params.id },
    });
    if (!config) throw new AppError(404, "CONFIG_NOT_FOUND", "Provider config not found");

    // Cannot enable a config that has never been tested — it must be CONNECTED
    // first via the /test endpoint before it can be toggled back on.
    if (enabled && config.status === "MISSING") {
      throw new AppError(
        409,
        "CONFIG_NOT_TESTED",
        "Provider config has not been tested yet. Run the connection test first.",
      );
    }

    // Enabling a previously-INVALID config is also blocked — credentials may
    // have been changed but not re-tested.
    if (enabled && config.status === "INVALID") {
      throw new AppError(
        409,
        "CONFIG_INVALID",
        "Provider config failed its last connection test. Fix the credentials and re-test before enabling.",
      );
    }

    const newStatus = enabled ? ProviderConfigStatus.CONNECTED : ProviderConfigStatus.DISABLED;

    await prisma.providerConfig.update({
      where: { id: config.id },
      data: { status: newStatus },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: enabled
          ? AuditAction.PROVIDER_CONFIG_ENABLED
          : AuditAction.PROVIDER_CONFIG_DISABLED,
        entityType: "ProviderConfig",
        entityId: config.id,
        metadata: { provider: config.provider, status: newStatus },
        ip: req.ip,
      },
    });

    res.json({ id: config.id, provider: config.provider, status: newStatus });
  }),
);

// ─── POST /provider-configs/:id/test ─────────────────────────────────────────────

router.post(
  "/:id/test",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const config = await db.providerConfig.findFirst({
      where: { id: req.params.id },
    });
    if (!config) throw new AppError(404, "CONFIG_NOT_FOUND", "Provider config not found");

    // Refuse to test a manually-disabled config — the operator must re-enable
    // it first (PATCH /:id/status { enabled: true }) to make this explicit.
    if (config.status === ProviderConfigStatus.DISABLED) {
      throw new AppError(
        409,
        "CONFIG_DISABLED",
        "Provider config is disabled. Enable it first before running the connection test.",
      );
    }

    const adapter = getAdapter(config.provider, config.encryptedCredentials);
    const result = await adapter.testConnection();

    const newStatus = result.connected
      ? ProviderConfigStatus.CONNECTED
      : ProviderConfigStatus.INVALID;
    await prisma.providerConfig.update({
      where: { id: config.id },
      data: { status: newStatus },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.PROVIDER_CONFIG_VALIDATED,
        entityType: "ProviderConfig",
        entityId: config.id,
        metadata: { provider: config.provider, result } as any,
        ip: req.ip,
      },
    });

    res.json({
      connected: result.connected,
      status: newStatus,
      error: result.error,
    });
  }),
);

// ─── DELETE /provider-configs/:id ────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const config = await db.providerConfig.findFirst({
      where: { id: req.params.id },
    });
    if (!config) throw new AppError(404, "CONFIG_NOT_FOUND", "Provider config not found");

    await prisma.providerConfig.delete({ where: { id: config.id } });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.PROVIDER_CONFIG_DELETED,
        entityType: "ProviderConfig",
        entityId: config.id,
        metadata: { provider: config.provider },
        ip: req.ip,
      },
    });

    res.status(204).send();
  }),
);

// ─── Admin: GET /admin/tenants/:id/provider-configs ───────────────────────────────

export const adminProviderConfigRouter = Router({ mergeParams: true });

adminProviderConfigRouter.get(
  "/",
  requireAuth,
  requireSuperAdmin, // M-10: only SUPER_ADMIN may view credentials, not SUPPORT_ADMIN
  asyncHandler(async (req, res) => {
    const configs = await prisma.providerConfig.findMany({
      where: { tenantId: req.params.id },
      select: {
        id: true,
        provider: true,
        status: true,
        environment: true,
        createdAt: true,
        updatedAt: true,
        encryptedCredentials: true,
      },
    });

    const result = configs.map((c) => {
      let maskedCredentials: Record<string, unknown> = {};
      try {
        maskedCredentials = maskCredentials(decryptCredentials(c.encryptedCredentials));
      } catch {
        /* ignore */
      }
      return {
        id: c.id,
        provider: c.provider,
        status: c.status,
        environment: c.environment,
        credentials: maskedCredentials,
      };
    });

    res.json(result);
  }),
);

export default router;
