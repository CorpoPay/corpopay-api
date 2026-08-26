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
});

describe("settlement-policies routes", () => {
  it("lists settlement policies", async () => {
    prisma.settlementPolicy.findMany.mockResolvedValue([
      {
        id: "sp-1",
        version: 1,
        name: null,
        industry: "saas",
        mcc: null,
        availabilityMode: "IMMEDIATE",
        availabilityDelayDays: null,
        reserveType: "NONE",
        reservePercentageBps: null,
        reserveHoldDays: null,
        reserveFixedCents: null,
        payoutSchedule: "AUTO_DAILY",
        payoutMinCents: null,
        reversalFunding: "NET_FROM_AVAILABLE",
        allowNegative: false,
        splittingEnabled: false,
        feeScheduleId: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(app)
      .get("/settlement-policies")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].industry).toBe("saas");
  });

  it("resolves the industry preset and returns the created policy", async () => {
    prisma.settlementPolicy.aggregate.mockResolvedValue({ _max: { version: 0 } });
    prisma.settlementPolicy.updateMany.mockResolvedValue({ count: 0 });
    prisma.settlementPolicy.create.mockImplementation(async ({ data }: any) => ({
      id: "sp-1",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(app)
      .post("/settlement-policies")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ industry: "travel" });

    expect(res.status).toBe(201);
    expect(res.body.industry).toBe("travel");
    expect(res.body.availabilityMode).toBe("DELAY");
    expect(res.body.availabilityDelayDays).toBe(7);
    expect(res.body.reserveType).toBe("ROLLING");
    expect(res.body.reservePercentageBps).toBe(1000);
    expect(res.body.payoutSchedule).toBe("AUTO_WEEKLY");
  });

  it("returns 404 when no active settlement policy", async () => {
    prisma.settlementPolicy.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/settlement-policies/active")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SETTLEMENT_POLICY_NOT_FOUND");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/settlement-policies");
    expect(res.status).toBe(401);
  });
});
