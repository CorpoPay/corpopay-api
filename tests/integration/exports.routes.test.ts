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

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  mockFindMany.mockResolvedValue([]);
});

describe("GET /exports/transactions.csv", () => {
  it("streams a CSV with the expected header", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "intent-1",
        correlationId: "corr-1",
        paymentLink: { reference: "REF-1", amount: "50.00", currency: "MAD", description: "Test" },
        providerTxs: [{ providerTransactionId: "tx-1" }],
        refunds: [],
        status: "SUCCEEDED",
        provider: "VPS",
        providerRef: "provider-ref-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(app)
      .get("/exports/transactions.csv")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("Intent ID");
    expect(res.text).toContain("corr-1");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/exports/transactions.csv");
    expect(res.status).toBe(401);
  });
});
