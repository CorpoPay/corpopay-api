-- CreateEnum
CREATE TYPE "SettlementStatementStatus" AS ENUM ('DRAFT', 'FINALIZED', 'VOID');

-- CreateTable
CREATE TABLE "settlement_statements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "status" "SettlementStatementStatus" NOT NULL DEFAULT 'DRAFT',
    "openingBalance" DECIMAL(12,2) NOT NULL,
    "closingBalance" DECIMAL(12,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_statement_items" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "category" "LedgerCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_statement_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_statements_tenantId_status_idx" ON "settlement_statements"("tenantId", "status");

-- CreateIndex
CREATE INDEX "settlement_statements_tenantId_periodEnd_idx" ON "settlement_statements"("tenantId", "periodEnd");

-- CreateIndex
CREATE INDEX "settlement_statement_items_statementId_idx" ON "settlement_statement_items"("statementId");

-- AddForeignKey
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_statement_items" ADD CONSTRAINT "settlement_statement_items_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "settlement_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
