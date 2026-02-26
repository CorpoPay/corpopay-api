import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { signToken, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { AppError } from '../middleware/errorHandler';
import { UserRole } from '@prisma/client';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  businessName: z.string().min(2).max(100),
  email:        z.string().email(),
  password:     z.string().min(8),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  token:    z.string(),
  password: z.string().min(8),
});

// ─── POST /auth/register ──────────────────────────────────────────────────────────

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { businessName, email, password } = RegisterSchema.parse(req.body);

    const slug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    // Check for duplicate email across tenant (globally unique for owners)
    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: businessName,
          slug: `${slug}-${Date.now()}`,
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId:     tenant.id,
          email,
          passwordHash,
          role:         UserRole.OWNER,
        },
      });

      return { tenant, user };
    });

    const token = signToken({
      sub:      user.id,
      tenantId: tenant.id,
      role:     user.role,
      email:    user.email,
    });

    res.status(201).json({
      token,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, environment: tenant.environment },
      user:   { id: user.id, email: user.email, role: user.role },
    });
  }),
);

// ─── POST /auth/login ─────────────────────────────────────────────────────────────

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = LoginSchema.parse(req.body);

    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
    if (!tenant || tenant.status === 'DISABLED') {
      throw new AppError(403, 'TENANT_DISABLED', 'This account has been disabled');
    }

    const token = signToken({
      sub:      user.id,
      tenantId: user.tenantId,
      role:     user.role,
      email:    user.email,
    });

    res.json({
      token,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, environment: tenant.environment },
      user:   { id: user.id, email: user.email, role: user.role },
    });
  }),
);

// ─── GET /auth/me ─────────────────────────────────────────────────────────────────

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: { id: true, email: true, role: true, createdAt: true, tenant: { select: { id: true, name: true, slug: true, environment: true, status: true } } },
    });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    res.json(user);
  }),
);

// ─── POST /auth/forgot-password ───────────────────────────────────────────────────
// MVP: returns 200 regardless to avoid user enumeration; email sending is a stub.

router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    ForgotPasswordSchema.parse(req.body);
    // TODO: generate reset token, store it, send email via SES/SendGrid
    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  }),
);

// ─── POST /auth/reset-password ────────────────────────────────────────────────────

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    ResetPasswordSchema.parse(req.body);
    // TODO: validate token, update password
    res.json({ message: 'Password updated.' });
  }),
);

export default router;
