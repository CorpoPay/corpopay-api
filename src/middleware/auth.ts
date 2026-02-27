import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';

interface JwtPayload {
  sub: string;       // userId
  tenantId: string;
  role: UserRole;
  email: string;
  iat?: number;
  exp?: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
}

/**
 * Verifies the Bearer token — accepts both JWTs (dashboard/browser sessions)
 * and API keys (cp_live_... / cp_test_... — for B2B integrations).
 *
 * API key path:
 *   1. SHA-256(rawKey) → look up ApiKey.keySha256 (O(1), indexed)
 *   2. If not found (legacy key missing keySha256): prefix-scan + bcrypt fallback,
 *      then backfill keySha256 for next time
 *   3. Verify key is not revoked + tenant is ACTIVE
 *   4. Load OWNER user → populate req.user identically to JWT path
 *
 * No route changes needed — requireMerchant / requireOwner continue to work
 * because req.user is fully populated in both paths.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
    return;
  }

  const token = header.slice(7);

  // ── API key path ─────────────────────────────────────────────────────────────
  if (token.startsWith('cp_live_') || token.startsWith('cp_test_')) {
    try {
      const sha256 = crypto.createHash('sha256').update(token).digest('hex');
      const prefix = token.slice(0, 16);

      // Fast path: indexed SHA-256 lookup (<1 ms)
      let apiKey = await prisma.apiKey.findFirst({
        where: { keySha256: sha256, revokedAt: null },
      });

      // Slow fallback: keys generated before keySha256 column existed
      if (!apiKey) {
        const candidates = await prisma.apiKey.findMany({
          where: { keyPrefix: prefix, keySha256: null, revokedAt: null },
        });
        for (const candidate of candidates) {
          if (await bcrypt.compare(token, candidate.keyHash)) {
            apiKey = candidate;
            // Backfill so next request hits the fast path
            prisma.apiKey
              .update({ where: { id: candidate.id }, data: { keySha256: sha256 } })
              .catch(() => { /* non-fatal */ });
            break;
          }
        }
      }

      if (!apiKey) {
        res.status(401).json({ error: 'Invalid or revoked API key', code: 'UNAUTHORIZED' });
        return;
      }

      const tenant = await prisma.tenant.findUnique({ where: { id: apiKey.tenantId } });
      if (!tenant || tenant.status === 'DISABLED') {
        res.status(403).json({ error: 'Tenant is disabled', code: 'TENANT_DISABLED' });
        return;
      }

      // Load OWNER so we have a valid userId for AuditLog.initiatedBy etc.
      const owner = await prisma.user.findFirst({
        where: { tenantId: apiKey.tenantId, role: UserRole.OWNER },
      });
      if (!owner) {
        res.status(500).json({ error: 'Tenant has no owner user', code: 'INTERNAL_ERROR' });
        return;
      }

      req.user = {
        id:       owner.id,
        tenantId: apiKey.tenantId,
        role:     UserRole.OWNER,
        email:    owner.email,
      };

      // Fire-and-forget lastUsedAt stamp
      prisma.apiKey
        .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
        .catch(() => { /* non-fatal */ });

      next();
    } catch (err) {
      next(err);
    }
    return;
  }

  // ── JWT path (dashboard sessions) ────────────────────────────────────────────
  try {
    const payload = jwt.verify(token, getSecret()) as JwtPayload;
    req.user = {
      id:       payload.sub,
      tenantId: payload.tenantId,
      role:     payload.role,
      email:    payload.email,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }
}

/**
 * Middleware factory — allows only the specified roles.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated', code: 'UNAUTHORIZED' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      return;
    }
    next();
  };
}

/**
 * Convenience — merchant routes (OWNER or STAFF).
 */
export const requireMerchant = requireRole(UserRole.OWNER, UserRole.STAFF);

/**
 * Convenience — owner-only actions (provider config, API keys, refunds).
 */
export const requireOwner = requireRole(UserRole.OWNER);

/**
 * Convenience — any admin.
 */
export const requireAdmin = requireRole(UserRole.SUPPORT_ADMIN, UserRole.SUPER_ADMIN);

/**
 * Convenience — super admin only.
 */
export const requireSuperAdmin = requireRole(UserRole.SUPER_ADMIN);

/**
 * Generate a signed JWT for a user.
 */
export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(
    { tenantId: payload.tenantId, role: payload.role, email: payload.email },
    getSecret(),
    {
      subject: payload.sub,
      expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    } as jwt.SignOptions,
  );
}
