-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'NEEDS_INFO');

-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "merchant_onboardings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "legalName" TEXT,
    "entityType" TEXT,
    "registrationNumber" TEXT,
    "country" TEXT,
    "businessAddress" TEXT,
    "website" TEXT,
    "contactEmail" TEXT,
    "industry" TEXT,
    "mcc" TEXT,
    "riskTier" "RiskTier" NOT NULL DEFAULT 'MEDIUM',
    "submittedAt" TIMESTAMP(3),
    "reviewerId" TEXT,
    "reviewNotes" TEXT,
    "rejectionReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_onboardings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_onboardings_tenantId_key" ON "merchant_onboardings"("tenantId");

-- CreateIndex
CREATE INDEX "merchant_onboardings_tenantId_status_idx" ON "merchant_onboardings"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "merchant_onboardings" ADD CONSTRAINT "merchant_onboardings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
