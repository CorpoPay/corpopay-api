-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'TAX_PAYABLE';

-- AlterEnum
ALTER TYPE "LedgerCategory" ADD VALUE 'TAX';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "taxExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxRateBps" INTEGER NOT NULL DEFAULT 0;
