-- Migration: add DISABLED to ProviderConfigStatus enum
-- Adds a DISABLED value so operators can soft-disable a provider config
-- without deleting it or invalidating its credentials.
-- Also adds two new audit actions for the enable/disable lifecycle.

-- ProviderConfigStatus: CONNECTED | INVALID | MISSING | DISABLED
ALTER TYPE "ProviderConfigStatus" ADD VALUE IF NOT EXISTS 'DISABLED';

-- AuditAction: track explicit enable / disable events
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROVIDER_CONFIG_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROVIDER_CONFIG_ENABLED';
