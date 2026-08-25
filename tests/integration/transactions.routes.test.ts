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

const mockFindMany = prisma.paymentIntent.findMany as ReturnType<typeof vi.fn>;
const mockCount = prisma.paymentIntent.count as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;

const INTENT = {
  id: "intent-1",
  correlationId: "corr-1",
  status: "SUCCEEDED",
  provider: "VPS",
  providerRef: "provider-ref-1",
  paymentLink: {
    slug: "link-1",
    reference: "REF-1",
    amount: "50.00",
    currency: "MAD",
    description: "Test",
  },
  providerTxs: [{ providerTransactionId: "tx-1" }],
  refunds: [],
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockFindFirst.mockResolvedValue(INTENT);
});

describe("transactions routes", () => {
  it("lists transactions with pagination", async () => {
    mockFindMany.mockResolvedValue([INTENT]);
    const res = await request(app)
      .get("/transactions")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].amount).toBe("50.00");
  });

  it("filters by status and provider", async () => {
    await request(app)
      .get("/transactions?status=SUCCEEDED&provider=VPS")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("SUCCEEDED");
    expect(where.provider).toBe("VPS");
  });

  it("returns transaction detail with a timeline", async () => {
    mockFindFirst.mockResolvedValue({
      ...INTENT,
      paymentLink: {
        ...INTENT.paymentLink,
        id: "link-1",
        status: "ACTIVE",
        createdAt: new Date(),
        customerName: null,
        customerEmail: null,
        customerPhone: null,
        provider: "VPS",
      },
      providerTxs: [],
      webhookEvents: [],
      refunds: [],
    });
    const res = await request(app)
      .get("/transactions/intent-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.timeline).toBeInstanceOf(Array);
  });

  it("returns 404 for a missing transaction", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await request(app)
      .get("/transactions/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(404);
  });
});
