-- Migration: add AUTHORIZED to PaymentIntentStatus enum
-- Distinguishes "authorized, funds on hold, awaiting merchant capture" (pre-auth)
-- from REQUIRES_ACTION ("customer must still complete the payment").
-- The capture/cancel routes now gate on AUTHORIZED instead of REQUIRES_ACTION.
ALTER TYPE "PaymentIntentStatus" ADD VALUE IF NOT EXISTS 'AUTHORIZED';
