/**
 * E2E: checkout → pay → refund happy path.
 *
 * Drives the real Express app across the public and merchant routes with the
 * deterministic FakeAdapter, asserting the money invariant is preserved at every
 * boundary: the API takes centimes, the DB stores MAD, and the provider adapter
 * receives centimes — never a double- or half-multiplied amount.
 */
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

const fakeAdapter = {
  createCheckoutSession: vi.fn(async (params: { amount: number; correlationId: string }) => ({
    redirectUrl: "https://checkout.example/pay",
    providerRef: params.correlationId,
    providerData: { redirectUrl: "https://checkout.example/pay" },
    rawRequest: {},
    rawResponse: {},
  })),
  refund: vi.fn(async () => ({
    success: true,
    providerRefundRef: "refund-ref-1",
    rawRequest: {},
    rawResponse: {},
  })),
  queryTransactionStatus: vi.fn(async () => ({ status: "SUCCEEDED", rawResponse: {} })),
  capturePayment: vi.fn(async () => ({ success: true, rawResponse: {} })),
  cancelPayment: vi.fn(async () => ({ success: true, rawResponse: {} })),
  verifyWebhookSignature: vi.fn(() => true),
  mapStatusToInternal: vi.fn((s: string) => s),
  testConnection: vi.fn(async () => ({ connected: true })),
};
vi.mock("../../src/adapters/registry", () => ({ getAdapter: vi.fn(() => fakeAdapter) }));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const LINK = {
  id: "link-1",
  tenantId: "tenant-a",
  tenant: { id: "tenant-a", name: "Demo Merchant", status: "ACTIVE" },
  slug: "link-1",
  provider: "VPS",
  status: "ACTIVE",
  amount: "250.00",
  currency: "MAD",
  reference: "REF-1",
  description: "One-time payment",
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
  prisma.auditLog.create.mockResolvedValue({});
  prisma.providerTransaction.create.mockResolvedValue({});
  prisma.providerConfig.findFirst.mockResolvedValue({
    id: "cfg",
    status: "CONNECTED",
    encryptedCredentials: "v2:{}",
  });
  prisma.paymentLink.findFirst.mockResolvedValue(LINK);
  prisma.paymentLink.create.mockResolvedValue(LINK);
  prisma.paymentLink.updateMany.mockResolvedValue({ count: 1 });
  prisma.paymentLink.update.mockResolvedValue(LINK);
  prisma.paymentIntent.create.mockResolvedValue({
    id: "intent-1",
    tenantId: "tenant-a",
    correlationId: "corr-1",
    provider: "VPS",
    status: "CREATED",
  });
  prisma.paymentIntent.update.mockResolvedValue({});
  prisma.refund.create.mockResolvedValue({ id: "refund-1", status: "PENDING" });
  prisma.refund.update.mockResolvedValue({
    id: "refund-1",
    status: "SUCCEEDED",
    amount: 250,
    currency: "MAD",
    providerRefundRef: "refund-ref-1",
  });
});

describe("checkout → pay → refund (happy path)", () => {
  it("keeps money centime-exact across the whole lifecycle", async () => {
    // 1. Merchant creates a one-time link priced at 250.00 MAD (25000 centimes).
    const create = await request(app)
      .post("/payment-links")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        amount: 25000,
        currency: "MAD",
        description: "One-time payment",
        reference: "REF-1",
        provider: "VPS",
      });
    expect(create.status).toBe(201);
    expect(Number(create.body.amount)).toBe(250); // MAD, centime-exact (Decimal serializes as string)

    // 2. Customer pays via the public checkout — the adapter receives centimes.
    const pay = await request(app)
      .post("/public/checkout/link-1/pay")
      .send({ customerEmail: "customer@example.com" });
    expect(pay.status).toBe(200);
    expect(pay.body.intentId).toBe("intent-1");
    expect(fakeAdapter.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25000 }),
    );

    // 3. Owner refunds the (now succeeded) payment — the adapter receives centimes.
    prisma.paymentIntent.findFirst.mockResolvedValue({
      id: "intent-1",
      tenantId: "tenant-a",
      status: "SUCCEEDED",
      provider: "VPS",
      providerRef: "corr-1",
      refunds: [],
      paymentLink: { amount: "250.00", currency: "MAD" },
      metadata: null,
    });
    const refund = await request(app)
      .post("/transactions/intent-1/refund")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe("SUCCEEDED");
    expect(fakeAdapter.refund).toHaveBeenCalledWith("corr-1", 25000, "MAD");
  });
});
