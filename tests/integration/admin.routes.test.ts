import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const ADMIN_TOKEN = mintToken({ id: "user-admin", tenantId: "tenant-a", role: "SUPER_ADMIN" });
const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockFindIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindWebhook = prisma.webhookEvent.findMany as ReturnType<typeof vi.fn>;
const mockCountWebhook = prisma.webhookEvent.count as ReturnType<typeof vi.fn>;
const mockFindHealth = prisma.providerHealth.findMany as ReturnType<typeof vi.fn>;
const mockUpsertHealth = prisma.providerHealth.upsert as ReturnType<typeof vi.fn>;
const mockFindPayouts = prisma.payout.findMany as ReturnType<typeof vi.fn>;
const mockCountPayouts = prisma.payout.count as ReturnType<typeof vi.fn>;
const mockFindOnboarding = prisma.merchantOnboarding.findMany as ReturnType<typeof vi.fn>;
const mockCountOnboarding = prisma.merchantOnboarding.count as ReturnType<typeof vi.fn>;
const mockFindDisputes = prisma.dispute.findMany as ReturnType<typeof vi.fn>;
const mockCountDisputes = prisma.dispute.count as ReturnType<typeof vi.fn>;
const mockFindReconciliation = prisma.reconciliationReport.findMany as ReturnType<typeof vi.fn>;
const mockCountReconciliation = prisma.reconciliationReport.count as ReturnType<typeof vi.fn>;
const mockFindStatements = prisma.settlementStatement.findMany as ReturnType<typeof vi.fn>;
const mockCountStatements = prisma.settlementStatement.count as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  mockFindIntent.mockResolvedValue(null);
  mockFindWebhook.mockResolvedValue([]);
  mockCountWebhook.mockResolvedValue(0);
  mockFindHealth.mockResolvedValue([]);
  mockUpsertHealth.mockResolvedValue({});
  prisma.providerTransaction.findFirst.mockResolvedValue(null);
  mockFindPayouts.mockResolvedValue([]);
  mockCountPayouts.mockResolvedValue(0);
  mockFindOnboarding.mockResolvedValue([]);
  mockCountOnboarding.mockResolvedValue(0);
  mockFindDisputes.mockResolvedValue([]);
  mockCountDisputes.mockResolvedValue(0);
  mockFindReconciliation.mockResolvedValue([]);
  mockCountReconciliation.mockResolvedValue(0);
  mockFindStatements.mockResolvedValue([]);
  mockCountStatements.mockResolvedValue(0);
});

describe("admin routes", () => {
  it("rejects a non-admin", async () => {
    const res = await request(app)
      .get("/admin/provider-health")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it("searches payments by query", async () => {
    mockFindIntent.mockResolvedValue({
      id: "intent-1",
      correlationId: "corr-1",
      status: "SUCCEEDED",
    });
    const res = await request(app)
      .get("/admin/payments/search?q=corr-1")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.intent.id).toBe("intent-1");
  });

  it("rejects a search query shorter than 2 characters", async () => {
    const res = await request(app)
      .get("/admin/payments/search?q=a")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("QUERY_TOO_SHORT");
  });

  it("returns found:false for an unknown payment", async () => {
    const res = await request(app)
      .get("/admin/payments/search?q=unknown")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it("lists webhook events", async () => {
    mockFindWebhook.mockResolvedValue([{ id: "wh-1", provider: "VPS" }]);
    const res = await request(app)
      .get("/admin/webhooks")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("lists provider health (always includes NAPS and VPS)", async () => {
    const res = await request(app)
      .get("/admin/provider-health")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.map((h: { provider: string }) => h.provider)).toEqual(
      expect.arrayContaining(["NAPS", "VPS"]),
    );
  });

  it("updates provider health (SUPER_ADMIN)", async () => {
    const res = await request(app)
      .put("/admin/provider-health/VPS")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "DEGRADED", notes: "latency" });
    expect(res.status).toBe(200);
    expect(mockUpsertHealth).toHaveBeenCalled();
  });

  it("executes a manual payout without calling a provider", async () => {
    prisma.payout.findUnique.mockResolvedValue({
      id: "payout-1",
      tenantId: "tenant-b",
      status: "DRAFT",
      amount: "100.00",
    });
    prisma.payout.findFirst.mockResolvedValue({
      id: "payout-1",
      tenantId: "tenant-b",
      status: "DRAFT",
      amount: "100.00",
    });
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
    prisma.ledgerEntry.create.mockResolvedValue({
      id: "le-1",
      postingId: "posting-1",
      account: "AVAILABLE",
      direction: "DEBIT",
      amount: "100.00",
      balanceAfter: "-100.00",
    });
    prisma.payout.update.mockResolvedValue({
      id: "payout-1",
      status: "PAID",
      providerTransferId: "bank-tr-001",
    });

    const res = await request(app)
      .post("/admin/payouts/payout-1/execute")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ externalReference: "bank-tr-001" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PAID");
    expect(res.body.providerTransferId).toBe("bank-tr-001");
    expect(prisma.payout.update).toHaveBeenCalled();
  });

  it("returns 404 when executing a missing payout", async () => {
    prisma.payout.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/admin/payouts/missing/execute")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ externalReference: "bank-tr-001" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PAYOUT_NOT_FOUND");
  });

  it("returns 409 when the payout is already paid", async () => {
    prisma.payout.findUnique.mockResolvedValue({
      id: "payout-1",
      tenantId: "tenant-b",
      status: "PAID",
      amount: "100.00",
    });

    const res = await request(app)
      .post("/admin/payouts/payout-1/execute")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ externalReference: "bank-tr-001" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PAYOUT_ALREADY_PAID");
  });

  it("lists payouts across tenants", async () => {
    mockFindPayouts.mockResolvedValue([
      {
        id: "payout-1",
        tenantId: "tenant-a",
        tenant: { name: "Demo", slug: "demo" },
        status: "DRAFT",
        provider: "VPS",
        method: "BANK_TRANSFER",
        currency: "MAD",
        amount: "100.00",
        feeAmount: "1.00",
        providerTransferId: null,
        idempotencyKey: "ik-1",
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCountPayouts.mockResolvedValue(1);

    const res = await request(app)
      .get("/admin/payouts")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].tenantSlug).toBe("demo");
    expect(res.body.total).toBe(1);
  });

  it("lists onboarding applications across tenants", async () => {
    mockFindOnboarding.mockResolvedValue([
      {
        id: "ob-1",
        tenantId: "tenant-a",
        tenant: { name: "Demo", slug: "demo" },
        status: "SUBMITTED",
        legalName: "Demo SARL",
        entityType: null,
        registrationNumber: null,
        country: "MA",
        businessAddress: null,
        website: null,
        contactEmail: null,
        industry: "retail",
        mcc: null,
        riskTier: "MEDIUM",
        submittedAt: new Date(),
        reviewerId: null,
        reviewNotes: null,
        rejectionReason: null,
        approvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCountOnboarding.mockResolvedValue(1);

    const res = await request(app)
      .get("/admin/onboarding")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].legalName).toBe("Demo SARL");
  });

  it("lists disputes across tenants", async () => {
    mockFindDisputes.mockResolvedValue([
      {
        id: "dispute-1",
        tenantId: "tenant-a",
        tenant: { name: "Demo", slug: "demo" },
        status: "OPEN",
        provider: "VPS",
        providerDisputeId: "pd-1",
        paymentIntentId: null,
        amount: "50.00",
        feeAmount: "0.00",
        currency: "MAD",
        reason: null,
        evidenceDueDate: null,
        recovery: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCountDisputes.mockResolvedValue(1);

    const res = await request(app)
      .get("/admin/disputes")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].providerDisputeId).toBe("pd-1");
  });

  it("lists reconciliation reports across tenants", async () => {
    mockFindReconciliation.mockResolvedValue([
      {
        id: "rec-1",
        tenantId: "tenant-a",
        tenant: { name: "Demo", slug: "demo" },
        provider: "VPS",
        currency: "MAD",
        periodStart: null,
        periodEnd: null,
        status: "PENDING",
        summary: null,
        lines: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCountReconciliation.mockResolvedValue(1);

    const res = await request(app)
      .get("/admin/reconciliation-reports")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].lineCount).toBe(0);
  });

  it("lists settlement statements across tenants", async () => {
    mockFindStatements.mockResolvedValue([
      {
        id: "stmt-1",
        tenantId: "tenant-a",
        tenant: { name: "Demo", slug: "demo" },
        periodStart: new Date(),
        periodEnd: new Date(),
        currency: "MAD",
        status: "DRAFT",
        openingBalance: "0.00",
        closingBalance: "100.00",
        netAmount: "100.00",
        finalizedAt: null,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCountStatements.mockResolvedValue(1);

    const res = await request(app)
      .get("/admin/settlement-statements")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].netCents).toBe(10000);
  });
});
