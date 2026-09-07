-- CreateEnum
CREATE TYPE "PayoutRail" AS ENUM ('STRIPE_CONNECT', 'MANUAL');

-- AlterTable
ALTER TABLE "settlement_policies" ADD COLUMN "payoutRail" "PayoutRail" NOT NULL DEFAULT 'MANUAL';
