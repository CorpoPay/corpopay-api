import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
vi.mock("../../src/config/inngest", () => ({
  inngestHandler: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../src/lib/inngest", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/adapters/registry", () => ({
  getAdapter: vi.fn(() => ({
    createCheckoutSession: vi.fn(async () => ({
      redirectUrl: "https://checkout.example/pay",
      providerRef: "provider-ref-1",
      providerData: { redirectUrl: "https://checkout.example/pay" },
      rawRequest: {},
      rawResponse: {},
    })),
    queryTransactionStatus: vi.fn(async () => ({ status: "SUCCEEDED", rawResponse: {} })),
    capturePayment: vi.fn(async () => ({ success: true, rawResponse: {} })),
    cancelPayment: vi.fn(async () => ({ success: true, rawResponse: {} })),
    verifyWebhookSignature: vi.fn(() => true),
    mapStatusToInternal: vi.fn((s: string) => s),
    testConnection: vi.fn(async () => ({ connected: true })),
  })),
}));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });
const ADMIN_TOKEN = mintToken({ id: "user-admin", tenantId: "tenant-a", role: "SUPER_ADMIN" });

const mockFindOnboarding = prisma.merchantOnboarding.findUnique as ReturnType<typeof vi.fn>;
const mockCountIntents = prisma.paymentIntent.count as ReturnType<typeof vi.fn>;
const mockCreateIntent = prisma.paymentIntent.create as ReturnType<typeof vi.fn>;
const mockFindConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockFindIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindIntentMany = prisma.paymentIntent.findMany as ReturnType<typeof vi.fn>;
const mockUpdateIntent = prisma.paymentIntent.update as ReturnType<typeof vi.fn>;
const mockFindLink = prisma.paymentLink.findFirst as ReturnType<typeof vi.fn>;
const mockUpdateLinkMany = prisma.paymentLink.updateMany as ReturnType<typeof vi.fn>;

const INTENT = {
  id: "intent-1",
  tenantId: "tenant-a",
  correlationId: "corr-1",
  provider: "VPS",
  status: "CREATED",
  riskVerdict: "ALLOW",
};

const CREATE_BODY = {
  provider: "VPS",
  amount: 5000,
  currency: "MAD",
  reference: "REF-1",
  description: "Direct payment",
  returnUrl: "https://example.com/return",
};

const LINK = {
  id: "link-1",
  tenantId: "tenant-a",
  tenant: { id: "tenant-a", status: "ACTIVE" },
  slug: "link-1",
  provider: "VPS",
  status: "ACTIVE",
  amount: "50.00",
  currency: "MAD",
  reference: "REF-1",
  description: "Test",
  maxAttempts: 3,
  attemptCount: 0,
  isInstallment: false,
  isRecurring: false,
  customerEmail: null,
  customerName: null,
  customerPhone: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.providerTransaction.create.mockResolvedValue({});
  mockFindConfig.mockResolvedValue({ status: "CONNECTED", encryptedCredentials: "v2:{}" });
  mockFindIntent.mockResolvedValue(null);
  mockCreateIntent.mockResolvedValue(INTENT);
  mockUpdateIntent.mockResolvedValue(INTENT);
  mockFindOnboarding.mockResolvedValue({ riskTier: "MEDIUM" });
  mockCountIntents.mockResolvedValue(0);
});

describe("POST /payment-intents (risk enforcement)", () => {
  it("blocks an amount above the tier threshold without creating an intent", async () => {
    mockFindOnboarding.mockResolvedValue({ riskTier: "HIGH" });
    const res = await request(app)
      .post("/payment-intents")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ ...CREATE_BODY, amount: 200000 });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("RISK_BLOCKED");
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it("flags a REVIEW verdict on the intent when velocity exceeds the threshold", async () => {
    mockCountIntents.mockResolvedValue(10); // MEDIUM maxPerWindow = 10
    const res = await request(app)
      .post("/payment-intents")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(mockCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ riskVerdict: "REVIEW" }) }),
    );
  });

  it("flags an ALLOW verdict for a normal charge", async () => {
    const res = await request(app)
      .post("/payment-intents")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(mockCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ riskVerdict: "ALLOW" }) }),
    );
  });
});

describe("POST /public/checkout/:slug/pay (risk enforcement)", () => {
  it("blocks the checkout when the charge exceeds the threshold", async () => {
    mockFindOnboarding.mockResolvedValue({ riskTier: "HIGH" });
    mockFindLink.mockResolvedValue({ ...LINK, amount: "2000.00" }); // 200000c > HIGH 100000c
    mockUpdateLinkMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post("/public/checkout/link-1/pay").send({});

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("RISK_BLOCKED");
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it("flags the checkout intent with the risk verdict", async () => {
    mockFindLink.mockResolvedValue(LINK);
    mockUpdateLinkMany.mockResolvedValue({ count: 1 });
    mockCreateIntent.mockResolvedValue({ ...INTENT, paymentLinkId: "link-1" });

    const res = await request(app).post("/public/checkout/link-1/pay").send({});

    expect(res.status).toBe(200);
    expect(mockCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ riskVerdict: "ALLOW" }) }),
    );
  });
});

describe("GET /admin/risk-decisions", () => {
  it("lists enforcement review intents (default REVIEW)", async () => {
    mockFindIntentMany.mockResolvedValue([
      {
        id: "intent-2",
        tenantId: "tenant-a",
        tenant: { name: "Tenant A", slug: "tenant-a" },
        riskVerdict: "REVIEW",
        provider: "VPS",
        correlationId: "corr-2",
        paymentLinkId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCountIntents.mockResolvedValue(1);

    const res = await request(app)
      .get("/admin/risk-decisions")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].verdict).toBe("REVIEW");
    expect(res.body.data[0].tenantSlug).toBe("tenant-a");
  });

  it("rejects non-admin callers", async () => {
    const res = await request(app)
      .get("/admin/risk-decisions")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(403);
  });
});

describe("POST /admin/risk-decisions/:id/resolve", () => {
  it("overrides a REVIEW verdict to ALLOW", async () => {
    mockUpdateIntent.mockResolvedValue({
      id: "intent-2",
      riskVerdict: "ALLOW",
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/admin/risk-decisions/intent-2/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ verdict: "ALLOW" });

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("ALLOW");
    expect(mockUpdateIntent).toHaveBeenCalledWith({
      where: { id: "intent-2" },
      data: { riskVerdict: "ALLOW" },
    });
  });

  it("rejects an invalid resolve verdict", async () => {
    const res = await request(app)
      .post("/admin/risk-decisions/intent-2/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ verdict: "REVIEW" });

    expect(res.status).toBe(422);
    expect(mockUpdateIntent).not.toHaveBeenCalled();
  });
});
