-- AlterEnum
ALTER TYPE "LedgerCategory" ADD VALUE 'FX_ADJUSTMENT';

-- AlterTable
ALTER TABLE "payment_intents" ADD COLUMN     "fxCurrencyPair" TEXT,
ADD COLUMN     "fxExpiresAt" TIMESTAMP(3),
ADD COLUMN     "fxRate" DECIMAL(18,8);

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "fxCurrencyPair" TEXT,
ADD COLUMN     "fxExpiresAt" TIMESTAMP(3),
ADD COLUMN     "fxRate" DECIMAL(18,8);
