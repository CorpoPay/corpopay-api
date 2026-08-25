import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
vi.mock("../../src/adapters/registry", () => ({
  getAdapter: vi.fn(() => ({
    refund: vi.fn(async () => ({
      success: true,
      providerRefundRef: "refund-ref-1",
      rawRequest: {},
      rawResponse: {},
    })),
    verifyWebhookSignature: vi.fn(),
    mapStatusToInternal: vi.fn(),
    testConnection: vi.fn(),
  })),
}));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });
const STAFF_TOKEN = mintToken({ id: "user-staff", tenantId: "tenant-a", role: "STAFF" });

const mockFindIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockCreateRefund = prisma.refund.create as ReturnType<typeof vi.fn>;
const mockUpdateRefund = prisma.refund.update as ReturnType<typeof vi.fn>;

const SUCCEEDED_INTENT = {
  id: "intent-1",
  tenantId: "tenant-a",
  status: "SUCCEEDED",
  provider: "VPS",
  providerRef: "provider-ref-1",
  refunds: [],
  paymentLink: { amount: "50.00", currency: "MAD" },
  metadata: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  prisma.providerTransaction.create.mockResolvedValue({});
  prisma.paymentIntent.update.mockResolvedValue({});
  mockFindConfig.mockResolvedValue({ id: "cfg", encryptedCredentials: "v2:{}" });
  mockCreateRefund.mockResolvedValue({ id: "refund-1", status: "PENDING" });
  mockUpdateRefund.mockResolvedValue({
    id: "refund-1",
    status: "SUCCEEDED",
    amount: 50,
    currency: "MAD",
    providerRefundRef: "refund-ref-1",
  });
});

describe("POST /transactions/:id/refund", () => {
  it("refunds a SUCCEEDED payment (partial amount from paymentLink)", async () => {
    mockFindIntent.mockResolvedValue(SUCCEEDED_INTENT);
    const res = await request(app)
      .post("/transactions/intent-1/refund")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCEEDED");
  });

  it("rejects refunding a non-SUCCEEDED intent", async () => {
    mockFindIntent.mockResolvedValue({ ...SUCCEEDED_INTENT, status: "FAILED" });
    const res = await request(app)
      .post("/transactions/intent-1/refund")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_REFUNDABLE");
  });

  it("rejects when a refund is already in progress or completed", async () => {
    mockFindIntent.mockResolvedValue({
      ...SUCCEEDED_INTENT,
      refunds: [{ status: "SUCCEEDED" }],
    });
    const res = await request(app)
      .post("/transactions/intent-1/refund")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(409);
  });

  it("rejects when there is no provider reference", async () => {
    mockFindIntent.mockResolvedValue({ ...SUCCEEDED_INTENT, providerRef: null });
    const res = await request(app)
      .post("/transactions/intent-1/refund")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_PROVIDER_REF");
  });

  it("is OWNER-only (STAFF is rejected)", async () => {
    const res = await request(app)
      .post("/transactions/intent-1/refund")
      .set("Authorization", `Bearer ${STAFF_TOKEN}`);
    expect(res.status).toBe(403);
  });
});
