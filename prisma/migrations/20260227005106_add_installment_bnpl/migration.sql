-- CreateEnum
CREATE TYPE "InstallmentAgreementStatus" AS ENUM ('PENDING_CHECKOUT', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'INSTALLMENT_PLAN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'INSTALLMENT_PLAN_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'INSTALLMENT_PLAN_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'INSTALLMENT_AGREEMENT_CANCELLED';

-- AlterTable
ALTER TABLE "payment_links" ADD COLUMN     "isInstallment" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "installment_plans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "annualInterestRate" DECIMAL(6,4) NOT NULL,
    "minAmount" DECIMAL(12,2),
    "maxAmount" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment_agreements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "paymentLinkId" TEXT,
    "initialPaymentIntentId" TEXT NOT NULL,
    "encryptedStoredProfileId" TEXT NOT NULL DEFAULT '',
    "status" "InstallmentAgreementStatus" NOT NULL DEFAULT 'PENDING_CHECKOUT',
    "principalAmount" DECIMAL(12,2) NOT NULL,
    "downPayment" DECIMAL(12,2) NOT NULL,
    "installmentAmount" DECIMAL(12,2) NOT NULL,
    "totalInstallments" INTEGER NOT NULL,
    "paidCount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "nextChargeDate" TIMESTAMP(3),
    "inngestRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installment_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment_charges" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "status" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "vpsTransactionId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installment_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "installment_plans_tenantId_idx" ON "installment_plans"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "installment_agreements_initialPaymentIntentId_key" ON "installment_agreements"("initialPaymentIntentId");

-- CreateIndex
CREATE INDEX "installment_agreements_tenantId_idx" ON "installment_agreements"("tenantId");

-- CreateIndex
CREATE INDEX "installment_agreements_status_idx" ON "installment_agreements"("status");

-- CreateIndex
CREATE INDEX "installment_agreements_paymentLinkId_idx" ON "installment_agreements"("paymentLinkId");

-- CreateIndex
CREATE INDEX "installment_charges_agreementId_idx" ON "installment_charges"("agreementId");

-- AddForeignKey
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_agreements" ADD CONSTRAINT "installment_agreements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_agreements" ADD CONSTRAINT "installment_agreements_planId_fkey" FOREIGN KEY ("planId") REFERENCES "installment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_agreements" ADD CONSTRAINT "installment_agreements_paymentLinkId_fkey" FOREIGN KEY ("paymentLinkId") REFERENCES "payment_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_agreements" ADD CONSTRAINT "installment_agreements_initialPaymentIntentId_fkey" FOREIGN KEY ("initialPaymentIntentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_charges" ADD CONSTRAINT "installment_charges_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "installment_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
