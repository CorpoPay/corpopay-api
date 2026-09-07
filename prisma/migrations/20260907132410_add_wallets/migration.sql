-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletOwnerType" AS ENUM ('TENANT', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('TOP_UP', 'DEBIT', 'REFUND', 'ADJUSTMENT');

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'WALLET';

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerType" "WalletOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallets_tenantId_idx" ON "wallets"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_tenantId_ownerType_ownerId_key" ON "wallets"("tenantId", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_idx" ON "wallet_transactions"("walletId");

-- CreateIndex
CREATE INDEX "wallet_transactions_tenantId_idx" ON "wallet_transactions"("tenantId");

-- CreateIndex
CREATE INDEX "wallet_transactions_tenantId_sourceType_sourceId_idx" ON "wallet_transactions"("tenantId", "sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
