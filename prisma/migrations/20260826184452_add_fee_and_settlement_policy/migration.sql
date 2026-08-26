-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('FLAT', 'PERCENTAGE', 'PER_METHOD', 'TIERED');

-- CreateEnum
CREATE TYPE "AvailabilityMode" AS ENUM ('IMMEDIATE', 'DELAY', 'ON_FULFILLMENT', 'ON_COLLECTION');

-- CreateEnum
CREATE TYPE "PayoutSchedule" AS ENUM ('MANUAL', 'AUTO_DAILY', 'AUTO_WEEKLY', 'AUTO_MONTHLY', 'THRESHOLD', 'INSTANT');

-- CreateEnum
CREATE TYPE "ReserveType" AS ENUM ('NONE', 'FIXED', 'ROLLING');

-- CreateEnum
CREATE TYPE "ReversalFundingPolicy" AS ENUM ('NET_FROM_AVAILABLE', 'DEBIT_RESERVE', 'INVOICE_TENANT', 'ALLOW_NEGATIVE');

-- CreateTable
CREATE TABLE "fee_schedules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT,
    "feeType" "FeeType" NOT NULL,
    "flatCents" INTEGER,
    "percentageBps" INTEGER,
    "perMethodCents" JSONB,
    "tiersCents" JSONB,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT,
    "industry" TEXT,
    "mcc" TEXT,
    "availabilityMode" "AvailabilityMode" NOT NULL DEFAULT 'IMMEDIATE',
    "availabilityDelayDays" INTEGER,
    "reserveType" "ReserveType" NOT NULL DEFAULT 'ROLLING',
    "reservePercentageBps" INTEGER,
    "reserveHoldDays" INTEGER,
    "reserveFixedCents" INTEGER,
    "payoutSchedule" "PayoutSchedule" NOT NULL DEFAULT 'AUTO_DAILY',
    "payoutMinCents" INTEGER,
    "reversalFunding" "ReversalFundingPolicy" NOT NULL DEFAULT 'NET_FROM_AVAILABLE',
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "splittingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "feeScheduleId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_schedules_tenantId_isActive_idx" ON "fee_schedules"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "fee_schedules_tenantId_version_key" ON "fee_schedules"("tenantId", "version");

-- CreateIndex
CREATE INDEX "settlement_policies_tenantId_isActive_idx" ON "settlement_policies"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_policies_tenantId_version_key" ON "settlement_policies"("tenantId", "version");

-- AddForeignKey
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_policies" ADD CONSTRAINT "settlement_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_policies" ADD CONSTRAINT "settlement_policies_feeScheduleId_fkey" FOREIGN KEY ("feeScheduleId") REFERENCES "fee_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
