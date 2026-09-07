-- Migration: add PAYOUT_MARKED_PAID, DISPUTE_RESOLVED, RISK_OVERRIDE to AuditAction
-- Three money-path admin/merchant writes (payout execution, dispute resolution,
-- manual risk override) mutated state without an audit trail. Each now records an
-- AuditLog row, closing the audit-log consistency gap for the money path.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYOUT_MARKED_PAID';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPUTE_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RISK_OVERRIDE';
