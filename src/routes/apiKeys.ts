import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Router } from "express";
import { AuditAction } from "@/generated/prisma/client";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createApiKeySchema } from "../schemas/api-keys";

const router = Router();

// ─── GET /api-keys ────────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const keys = await db.apiKey.findMany({
      where: { revokedAt: null },
      select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(keys);
  }),
);

// ─── POST /api-keys ───────────────────────────────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { name } = createApiKeySchema.parse(req.body);

    // Generate a raw key: cp_live_<32 random hex bytes> = 76 chars total
    const rawKey = `cp_live_${crypto.randomBytes(32).toString("hex")}`;
    const keyPrefix = rawKey.slice(0, 16); // "cp_live_xxxxxxxx" — first 16 chars shown in UI
    const keyHash = await bcrypt.hash(rawKey, 10);
    const keySha256 = crypto.createHash("sha256").update(rawKey).digest("hex");

    const apiKey = await prisma.apiKey.create({
      data: {
        tenantId: req.user!.tenantId,
        name,
        keyHash,
        keySha256,
        keyPrefix,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.API_KEY_CREATED,
        entityType: "ApiKey",
        entityId: apiKey.id,
        metadata: { name },
        ip: req.ip,
      },
    });

    // Return raw key ONCE — never stored in plain text
    res.status(201).json({
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      rawKey, // shown once only
      createdAt: apiKey.createdAt,
    });
  }),
);

// ─── DELETE /api-keys/:id ─────────────────────────────────────────────────────────

router.delete(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const key = await db.apiKey.findFirst({
      where: { id: req.params.id, revokedAt: null },
    });
    if (!key) throw new AppError(404, "KEY_NOT_FOUND", "API key not found");

    await prisma.apiKey.update({
      where: { id: key.id },
      data: { revokedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.API_KEY_REVOKED,
        entityType: "ApiKey",
        entityId: key.id,
        ip: req.ip,
      },
    });

    res.status(204).send();
  }),
);

export default router;
