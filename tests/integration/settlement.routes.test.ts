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

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.ledgerEntry.groupBy.mockResolvedValue([]);
  prisma.ledgerEntry.findMany.mockResolvedValue([]);
  prisma.payout.findMany.mockResolvedValue([]);
});

describe("settlement routes", () => {
  it("returns the net-owed summary and payout rail", async () => {
    prisma.settlementPolicy.findFirst.mockResolvedValue({ payoutRail: "MANUAL" });

    const res = await request(app)
      .get("/settlement/summary")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currency: "MAD",
      availableCents: 0,
      scheduledCents: 0,
      eligibleCents: 0,
      feesCents: 0,
      reserveCents: 0,
      paidOutCents: 0,
      payoutRail: "MANUAL",
    });
  });

  it("returns a null payoutRail when no active policy exists", async () => {
    prisma.settlementPolicy.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/settlement/summary")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.payoutRail).toBe(null);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/settlement/summary");
    expect(res.status).toBe(401);
  });
});
