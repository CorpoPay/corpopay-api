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

describe("GET /dashboard/summary", () => {
  it("returns today + week totals and a payout placeholder", async () => {
    mockFindMany.mockResolvedValue([
      {
        createdAt: new Date(), // today
        paymentLink: { amount: "50.00", currency: "MAD" },
        metadata: null,
      },
      {
        createdAt: new Date(), // today
        paymentLink: null,
        metadata: { amount: 10000, currency: "MAD" }, // centimes → MAD
      },
    ]);

    const res = await request(app)
      .get("/dashboard/summary")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.today.count).toBe(2);
    // 50.00 (link) + 100.00 (direct, centimes → MAD) = 150.00
    expect(res.body.today.total).toBe(150);
    expect(res.body.payoutStatus).toBe("NOT_APPLICABLE");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/dashboard/summary");
    expect(res.status).toBe(401);
  });
});
