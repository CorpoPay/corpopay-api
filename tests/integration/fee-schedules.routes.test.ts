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

describe("fee-schedules routes", () => {
  it("lists fee schedules", async () => {
    prisma.feeSchedule.findMany.mockResolvedValue([
      {
        id: "fs-1",
        version: 1,
        name: null,
        feeType: "PERCENTAGE",
        flatCents: null,
        percentageBps: 290,
        perMethodCents: null,
        tiersCents: null,
        currency: "MAD",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(app)
      .get("/fee-schedules")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].feeType).toBe("PERCENTAGE");
    expect(res.body[0].percentageBps).toBe(290);
  });

  it("creates a fee schedule (new active version)", async () => {
    prisma.feeSchedule.aggregate.mockResolvedValue({ _max: { version: 1 } });
    prisma.feeSchedule.updateMany.mockResolvedValue({ count: 1 });
    prisma.feeSchedule.create.mockResolvedValue({
      id: "fs-2",
      version: 2,
      name: null,
      feeType: "FLAT",
      flatCents: 250,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: null,
      currency: "MAD",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/fee-schedules")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ feeType: "FLAT", flatCents: 250 });

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
    expect(res.body.feeType).toBe("FLAT");
    expect(res.body.flatCents).toBe(250);
  });

  it("returns 404 when no active fee schedule", async () => {
    prisma.feeSchedule.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/fee-schedules/active")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("FEE_SCHEDULE_NOT_FOUND");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/fee-schedules");
    expect(res.status).toBe(401);
  });
});
