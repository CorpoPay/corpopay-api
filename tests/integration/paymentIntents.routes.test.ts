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

import { getAdapter } from "../../src/adapters/registry";
import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockFindConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockFindIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockCreateIntent = prisma.paymentIntent.create as ReturnType<typeof vi.fn>;
const mockUpdateMany = prisma.paymentIntent.updateMany as ReturnType<typeof vi.fn>;
const mockUpdateIntent = prisma.paymentIntent.update as ReturnType<typeof vi.fn>;
const mockFindLink = prisma.paymentLink.findFirst as ReturnType<typeof vi.fn>;
const mockUpdateLinkMany = prisma.paymentLink.updateMany as ReturnType<typeof vi.fn>;

const INTENT = {
  id: "intent-1",
  tenantId: "tenant-a",
  correlationId: "corr-1",
  provider: "VPS",
  status: "CREATED",
};

const CREATE_BODY = {
  provider: "VPS",
  amount: 5000,
  currency: "MAD",
  reference: "REF-1",
  description: "Direct payment",
  returnUrl: "https://example.com/return",
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.providerTransaction.create.mockResolvedValue({});
  mockFindConfig.mockResolvedValue({ status: "CONNECTED", encryptedCredentials: "v2:{}" });
  mockFindIntent.mockResolvedValue(null);
  mockCreateIntent.mockResolvedValue(INTENT);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockUpdateIntent.mockResolvedValue(INTENT);
});

describe("POST /payment-intents", () => {
  it("creates a direct intent and returns a correlationId + redirectUrl", async () => {
    const res = await request(app)
      .post("/payment-intents")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.correlationId).toBe("corr-1");
    expect(res.body.redirectUrl).toBe("https://checkout.example/pay");
    expect(getAdapter).toHaveBeenCalled();
  });

  it("returns the existing intent idempotently for a repeated reference", async () => {
    mockFindIntent.mockResolvedValue({
      ...INTENT,
      status: "REQUIRES_ACTION",
      providerData: { redirectUrl: "https://checkout.example/pay" },
    });
    const res = await request(app)
      .post("/payment-intents")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send(CREATE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(mockCreateIntent).not.toHaveBeenCalled();
  });

  it("returns 503 when the provider is not connected", async () => {
    mockFindConfig.mockResolvedValue(null);
    const res = await request(app)
      .post("/payment-intents")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send(CREATE_BODY);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("GET /payment-intents/:id", () => {
  it("returns an intent detail", async () => {
    mockFindIntent.mockResolvedValue({
      ...INTENT,
      paymentLink: null,
      providerTxs: [],
      refunds: [],
      webhookEvents: [],
    });
    const res = await request(app)
      .get("/payment-intents/intent-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe("corr-1");
  });

  it("returns 404 for a missing intent", async () => {
    mockFindIntent.mockResolvedValue(null);
    const res = await request(app)
      .get("/payment-intents/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /payment-intents/:id/capture", () => {
  it("captures a pre-authorised intent", async () => {
    mockFindIntent.mockResolvedValue({
      ...INTENT,
      status: "REQUIRES_ACTION",
      providerRef: "provider-ref-1",
      paymentLink: null,
      metadata: { amount: 5000 },
    });
    const res = await request(app)
      .post("/payment-intents/intent-1/capture")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
  });

  it("returns 409 when the intent is not in REQUIRES_ACTION", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockFindIntent.mockResolvedValue({ ...INTENT, status: "SUCCEEDED" });
    const res = await request(app)
      .post("/payment-intents/intent-1/capture")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(409);
  });
});

describe("POST /payment-intents/:id/cancel", () => {
  it("cancels a pre-authorised intent", async () => {
    mockFindIntent.mockResolvedValue({
      ...INTENT,
      status: "REQUIRES_ACTION",
      providerRef: "provider-ref-1",
      paymentLink: null,
      metadata: { amount: 5000 },
    });
    const res = await request(app)
      .post("/payment-intents/intent-1/cancel")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELED");
  });
});

describe("POST /public/checkout/:slug/pay", () => {
  const link = {
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
    mockFindLink.mockResolvedValue(link);
    mockUpdateLinkMany.mockResolvedValue({ count: 1 });
  });

  it("creates a payment intent from a payment link", async () => {
    mockCreateIntent.mockResolvedValue({ ...INTENT, paymentLinkId: "link-1" });
    const res = await request(app)
      .post("/public/checkout/link-1/pay")
      .send({ customerEmail: "customer@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.intentId).toBe("intent-1");
  });

  it("returns 410 for a non-ACTIVE link", async () => {
    mockFindLink.mockResolvedValue({ ...link, status: "CANCELED" });
    const res = await request(app).post("/public/checkout/link-1/pay").send({});
    expect(res.status).toBe(410);
  });

  it("returns 429 when max attempts are exhausted", async () => {
    mockUpdateLinkMany.mockResolvedValue({ count: 0 });
    const res = await request(app).post("/public/checkout/link-1/pay").send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("MAX_ATTEMPTS");
  });
});

describe("GET /public/pay/:correlationId", () => {
  it("returns JSON status for an API client on a terminal intent", async () => {
    prisma.paymentIntent.findUnique.mockResolvedValue({ status: "SUCCEEDED", providerData: null });
    const res = await request(app).get("/public/pay/corr-1").set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
  });

  it("returns 404 for an unknown correlationId", async () => {
    prisma.paymentIntent.findUnique.mockResolvedValue(null);
    const res = await request(app).get("/public/pay/unknown");
    expect(res.status).toBe(404);
  });
});
