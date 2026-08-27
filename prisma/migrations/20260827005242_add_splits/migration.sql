-- CreateEnum
CREATE TYPE "SplitTrigger" AS ENUM ('AT_CAPTURE', 'ON_USAGE', 'MANUAL');

-- CreateEnum
CREATE TYPE "SplitPartyType" AS ENUM ('PLATFORM', 'SUB_MERCHANT', 'VENDOR', 'AFFILIATE', 'ESCROW');

-- CreateEnum
CREATE TYPE "SplitStatus" AS ENUM ('PENDING', 'SETTLED', 'REVERSED');

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "partyId" TEXT;

-- CreateTable
CREATE TABLE "split_parties" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SplitPartyType" NOT NULL DEFAULT 'SUB_MERCHANT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "SplitTrigger" NOT NULL DEFAULT 'AT_CAPTURE',
    "shares" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "splitRuleId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "status" "SplitStatus" NOT NULL DEFAULT 'PENDING',
    "heldUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "splits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "split_parties_tenantId_isActive_idx" ON "split_parties"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "split_parties_tenantId_slug_key" ON "split_parties"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "split_rules_tenantId_isActive_idx" ON "split_rules"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "splits_tenantId_status_idx" ON "splits"("tenantId", "status");

-- CreateIndex
CREATE INDEX "splits_tenantId_sourceType_sourceId_idx" ON "splits"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantId_partyId_account_idx" ON "ledger_entries"("tenantId", "partyId", "account");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "split_parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_parties" ADD CONSTRAINT "split_parties_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_rules" ADD CONSTRAINT "split_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splits" ADD CONSTRAINT "splits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splits" ADD CONSTRAINT "splits_splitRuleId_fkey" FOREIGN KEY ("splitRuleId") REFERENCES "split_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splits" ADD CONSTRAINT "splits_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "split_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
