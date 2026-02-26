import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

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
 * Verifies JWT from Authorization header and attaches req.user.
 * Returns 401 if missing or invalid.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, getSecret()) as JwtPayload;
    req.user = {
      id: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      email: payload.email,
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
