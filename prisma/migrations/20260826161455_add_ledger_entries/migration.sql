-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('CASH', 'PENDING', 'COLLECTED', 'AVAILABLE', 'RESERVE', 'FEES', 'PAID_OUT');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerCategory" AS ENUM ('CAPTURE', 'REFUND', 'FEE', 'SPLIT', 'PAYOUT', 'CHARGEBACK', 'RESERVE_RELEASE', 'ADJUSTMENT', 'DISBURSEMENT');

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "category" "LedgerCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_entries_postingId_idx" ON "ledger_entries"("postingId");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantId_account_idx" ON "ledger_entries"("tenantId", "account");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantId_sourceType_sourceId_idx" ON "ledger_entries"("tenantId", "sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
