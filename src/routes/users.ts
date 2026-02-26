import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuditAction, UserRole } from '@prisma/client';

const router = Router();

// ─── GET /users ───────────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      where:  { tenantId: req.user!.tenantId },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    res.json(users);
  }),
);

// ─── POST /users/invite ───────────────────────────────────────────────────────────

const InviteSchema = z.object({
  email:    z.string().email(),
  role:     z.enum([UserRole.STAFF, UserRole.OWNER]),
  password: z.string().min(8), // MVP: direct password set; replace with email invite later
});

router.post(
  '/invite',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { email, role, password } = InviteSchema.parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { tenantId: req.user!.tenantId, email },
    });
    if (existing) throw new AppError(409, 'EMAIL_TAKEN', 'User with this email already exists in your workspace');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { tenantId: req.user!.tenantId, email, passwordHash, role },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.USER_INVITED,
        entityType: 'User',
        entityId:   user.id,
        metadata:   { role },
        ip:         req.ip,
      },
    });

    res.status(201).json({ id: user.id, email: user.email, role: user.role });
  }),
);

// ─── PATCH /users/:id/role ────────────────────────────────────────────────────────

router.patch(
  '/:id/role',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { role } = z.object({ role: z.enum([UserRole.STAFF, UserRole.OWNER]) }).parse(req.body);

    // Prevent owner from demoting themselves if they're the only owner
    if (req.params.id === req.user!.id && role !== UserRole.OWNER) {
      const ownerCount = await prisma.user.count({
        where: { tenantId: req.user!.tenantId, role: UserRole.OWNER },
      });
      if (ownerCount <= 1) {
        throw new AppError(400, 'LAST_OWNER', 'Cannot remove the only owner from the tenant');
      }
    }

    const user = await prisma.user.update({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      data:  { role },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.USER_ROLE_CHANGED,
        entityType: 'User',
        entityId:   user.id,
        metadata:   { newRole: role },
        ip:         req.ip,
      },
    });

    res.json({ id: user.id, email: user.email, role: user.role });
  }),
);

// ─── DELETE /users/:id ────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.id) {
      throw new AppError(400, 'CANNOT_DELETE_SELF', 'Cannot remove your own account');
    }

    await prisma.user.delete({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.USER_REMOVED,
        entityType: 'User',
        entityId:   req.params.id,
        ip:         req.ip,
      },
    });

    res.status(204).send();
  }),
);

export default router;
