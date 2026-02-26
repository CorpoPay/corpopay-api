-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Provider" ADD VALUE 'STRIPE';
ALTER TYPE "Provider" ADD VALUE 'PAYPAL';
ALTER TYPE "Provider" ADD VALUE 'ADYEN';

-- DropForeignKey
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_paymentLinkId_fkey";

-- AlterTable
ALTER TABLE "payment_intents" ALTER COLUMN "paymentLinkId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_paymentLinkId_fkey" FOREIGN KEY ("paymentLinkId") REFERENCES "payment_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
