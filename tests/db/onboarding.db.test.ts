import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OnboardingError } from "@/lib/onboarding";
import {
  approveOnboarding,
  getOnboarding,
  rejectOnboarding,
  requestInfoOnboarding,
  submitOnboarding,
  upsertOnboarding,
} from "@/lib/onboarding-db";
import { prisma } from "@/lib/prisma";
import { makeTenant } from "../factories";

/**
 * Real-Postgres onboarding suite. Verifies what a mock cannot: that the
 * DRAFT → SUBMITTED → (APPROVED | REJECTED | NEEDS_INFO) lifecycle persists,
 * that resubmission is allowed after rejection / info-needed, and that approval
 * resolves the tenant's industry into a valid `SettlementPolicy` preset.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "onboarding-db-a";

const COMPLETE = {
  legalName: "Acme SARL",
  entityType: "llc",
  registrationNumber: "REG-1",
  country: "MA",
  businessAddress: "Casablanca",
  website: "https://acme.example.com",
  contactEmail: "owner@acme.example.com",
  industry: "retail",
  mcc: "5999",
};

describe("merchant onboarding persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.merchantOnboarding.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Onboarding DB A" }),
    });
  });

  afterAll(async () => {
    await prisma.merchantOnboarding.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.merchantOnboarding.deleteMany({ where: { tenantId: TENANT } });
  });

  it("drafts, submits, and approves — resolving the industry preset", async () => {
    await upsertOnboarding(TENANT, COMPLETE);
    const draft = await getOnboarding(TENANT);
    expect(draft?.status).toBe("DRAFT");
    expect(draft?.riskTier).toBe("LOW"); // retail → LOW

    const submitted = await submitOnboarding(TENANT);
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedAt).not.toBeNull();

    const { onboarding, policySpec } = await approveOnboarding(TENANT, "reviewer-1");
    expect(onboarding.status).toBe("APPROVED");
    expect(onboarding.approvedAt).not.toBeNull();
    expect(policySpec.industry).toBe("retail");
    expect(policySpec.mcc).toBe("5999");
    expect(policySpec.reserveType).toBe("ROLLING");
  });

  it("rejects a submitted onboarding, then allows resubmission", async () => {
    await upsertOnboarding(TENANT, COMPLETE);
    await submitOnboarding(TENANT);

    const rejected = await rejectOnboarding(TENANT, "reviewer-1", "Missing document");
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("Missing document");

    const resubmitted = await submitOnboarding(TENANT);
    expect(resubmitted.status).toBe("SUBMITTED");
  });

  it("requests info, then allows resubmission", async () => {
    await upsertOnboarding(TENANT, COMPLETE);
    await submitOnboarding(TENANT);

    const needsInfo = await requestInfoOnboarding(TENANT, "reviewer-1", "Clarify address");
    expect(needsInfo.status).toBe("NEEDS_INFO");
    expect(needsInfo.reviewNotes).toBe("Clarify address");

    const resubmitted = await submitOnboarding(TENANT);
    expect(resubmitted.status).toBe("SUBMITTED");
  });

  it("rejects submitting an incomplete onboarding", async () => {
    await upsertOnboarding(TENANT, { ...COMPLETE, industry: undefined });
    await expect(submitOnboarding(TENANT)).rejects.toThrow(OnboardingError);
  });

  it("rejects an illegal transition (approve from DRAFT)", async () => {
    await upsertOnboarding(TENANT, COMPLETE);
    await expect(approveOnboarding(TENANT, "reviewer-1")).rejects.toThrow(/DRAFT -> APPROVED/);
  });
});
