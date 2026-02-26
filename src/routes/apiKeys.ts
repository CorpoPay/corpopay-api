import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuditAction } from '@prisma/client';

const router = Router();

// ─── GET /api-keys ────────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      where:   { tenantId: req.user!.tenantId, revokedAt: null },
      select:  { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(keys);
  }),
);

// ─── POST /api-keys ───────────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);

    // Generate a raw key: cp_live_<32 random hex bytes>
    const rawKey = `cp_live_${crypto.randomBytes(32).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 16); // "cp_live_xxxxxxxx" ─ first 16 chars shown in UI
    const keyHash = await bcrypt.hash(rawKey, 10);

    const apiKey = await prisma.apiKey.create({
      data: {
        tenantId:  req.user!.tenantId,
        name,
        keyHash,
        keyPrefix,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.API_KEY_CREATED,
        entityType: 'ApiKey',
        entityId:   apiKey.id,
        metadata:   { name },
        ip:         req.ip,
      },
    });

    // Return raw key ONCE — never stored in plain text
    res.status(201).json({
      id:        apiKey.id,
      name:      apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      rawKey,    // shown once only
      createdAt: apiKey.createdAt,
    });
  }),
);

// ─── DELETE /api-keys/:id ─────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const key = await prisma.apiKey.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId, revokedAt: null },
    });
    if (!key) throw new AppError(404, 'KEY_NOT_FOUND', 'API key not found');

    await prisma.apiKey.update({
      where: { id: key.id },
      data:  { revokedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.API_KEY_REVOKED,
        entityType: 'ApiKey',
        entityId:   key.id,
        ip:         req.ip,
      },
    });

    res.status(204).send();
  }),
);

export default router;
