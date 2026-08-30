import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });
const ADMIN_TOKEN = mintToken({
  id: "user-admin",
  tenantId: "admin-tenant",
  role: "SUPPORT_ADMIN",
});

function onboardingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "onboarding-1",
    tenantId: "tenant-a",
    status: "DRAFT",
    legalName: "Acme SARL",
    entityType: "llc",
    registrationNumber: "REG-1",
    country: "MA",
    businessAddress: "Casablanca",
    website: "https://acme.example.com",
    contactEmail: "owner@acme.example.com",
    industry: "retail",
    mcc: "5999",
    riskTier: "LOW",
    submittedAt: null,
    reviewerId: null,
    reviewNotes: null,
    rejectionReason: null,
    approvedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("merchant onboarding", () => {
  it("GET /onboarding returns the tenant's application", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(onboardingRow());

    const res = await request(app).get("/onboarding").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.industry).toBe("retail");
    expect(res.body.riskTier).toBe("LOW");
  });

  it("GET /onboarding returns 404 before drafting", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(null);

    const res = await request(app).get("/onboarding").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ONBOARDING_NOT_FOUND");
  });

  it("PUT /onboarding upserts the draft", async () => {
    prisma.merchantOnboarding.upsert.mockResolvedValue(
      onboardingRow({ industry: "saas", riskTier: "LOW" }),
    );

    const res = await request(app)
      .put("/onboarding")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        legalName: "Acme SARL",
        entityType: "llc",
        country: "MA",
        industry: "saas",
        mcc: "5734",
      });

    expect(res.status).toBe(200);
    expect(prisma.merchantOnboarding.upsert).toHaveBeenCalled();
  });

  it("PUT /onboarding rejects a malformed country", async () => {
    const res = await request(app)
      .put("/onboarding")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ country: "MOROCCO" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(prisma.merchantOnboarding.upsert).not.toHaveBeenCalled();
  });

  it("POST /onboarding/submit submits a complete application", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(onboardingRow());
    prisma.merchantOnboarding.update.mockResolvedValue(
      onboardingRow({ status: "SUBMITTED", submittedAt: new Date("2026-01-02T00:00:00Z") }),
    );

    const res = await request(app)
      .post("/onboarding/submit")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUBMITTED");
  });

  it("POST /onboarding/submit returns 422 for an incomplete application", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(
      onboardingRow({ industry: null, legalName: null }),
    );

    const res = await request(app)
      .post("/onboarding/submit")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("ONBOARDING_INCOMPLETE");
    expect(prisma.merchantOnboarding.update).not.toHaveBeenCalled();
  });
});

describe("admin onboarding review", () => {
  it("POST /admin/onboarding/:tenantId/approve resolves the policy preset", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(
      onboardingRow({ status: "SUBMITTED", industry: "marketplace", mcc: "5262" }),
    );
    prisma.merchantOnboarding.update.mockResolvedValue(
      onboardingRow({ status: "APPROVED", approvedAt: new Date("2026-01-03T00:00:00Z") }),
    );

    const res = await request(app)
      .post("/admin/onboarding/tenant-a/approve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.policySpec.industry).toBe("marketplace");
    expect(res.body.policySpec.splittingEnabled).toBe(true);
  });

  it("POST /admin/onboarding/:tenantId/reject records the reason", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(onboardingRow({ status: "SUBMITTED" }));
    prisma.merchantOnboarding.update.mockResolvedValue(
      onboardingRow({ status: "REJECTED", rejectionReason: "Missing document" }),
    );

    const res = await request(app)
      .post("/admin/onboarding/tenant-a/reject")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ reason: "Missing document" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.rejectionReason).toBe("Missing document");
  });

  it("POST /admin/onboarding/:tenantId/request-info records notes", async () => {
    prisma.merchantOnboarding.findFirst.mockResolvedValue(onboardingRow({ status: "SUBMITTED" }));
    prisma.merchantOnboarding.update.mockResolvedValue(
      onboardingRow({ status: "NEEDS_INFO", reviewNotes: "Clarify address" }),
    );

    const res = await request(app)
      .post("/admin/onboarding/tenant-a/request-info")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ notes: "Clarify address" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("NEEDS_INFO");
  });

  it("rejects a merchant owner calling an admin action", async () => {
    const res = await request(app)
      .post("/admin/onboarding/tenant-a/approve")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });
});

describe("auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/onboarding");
    expect(res.status).toBe(401);
  });
});
