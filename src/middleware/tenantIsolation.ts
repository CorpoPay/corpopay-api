import { Request, Response, NextFunction } from 'express';

/**
 * Validates that req.params.tenantId (if present) matches req.user.tenantId.
 * Used on routes like /tenants/:tenantId/... to prevent cross-tenant access.
 */
export function enforceTenantParam(req: Request, res: Response, next: NextFunction): void {
  const paramTenantId = req.params.tenantId;
  if (!paramTenantId) {
    next();
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated', code: 'UNAUTHORIZED' });
    return;
  }
  if (req.user.tenantId !== paramTenantId) {
    res.status(403).json({ error: 'Access denied to this tenant', code: 'TENANT_MISMATCH' });
    return;
  }
  next();
}

/**
 * Returns the tenantId from req.user, throwing 401 if not set.
 * Utility used inside route handlers.
 */
export function getTenantId(req: Request): string {
  if (!req.user?.tenantId) {
    throw new Error('Tenant context missing from request');
  }
  return req.user.tenantId;
}
