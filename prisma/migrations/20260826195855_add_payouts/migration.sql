-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK_TRANSFER', 'CARD', 'WALLET');

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "status" "PayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "provider" "Provider" NOT NULL,
    "providerTransferId" TEXT,
    "feeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "method" "PayoutMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_items" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payouts_tenantId_status_idx" ON "payouts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_tenantId_idempotencyKey_key" ON "payouts"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payout_items_ledgerEntryId_key" ON "payout_items"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "payout_items_payoutId_idx" ON "payout_items"("payoutId");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
