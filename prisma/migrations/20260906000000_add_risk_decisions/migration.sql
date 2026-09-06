-- CreateEnum
CREATE TYPE "RiskVerdict" AS ENUM ('ALLOW', 'REVIEW', 'BLOCK');

-- CreateTable
CREATE TABLE "risk_decisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "verdict" "RiskVerdict" NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "risk_decisions_eventId_key" ON "risk_decisions"("eventId");

-- CreateIndex
CREATE INDEX "risk_decisions_tenantId_idx" ON "risk_decisions"("tenantId");

-- AddForeignKey
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
