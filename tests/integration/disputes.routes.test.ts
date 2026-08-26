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

function disputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispute-1",
    status: "OPEN",
    provider: "VPS",
    providerDisputeId: "dispute-vps-1",
    paymentIntentId: null,
    amount: "100.00",
    feeAmount: "0.00",
    currency: "MAD",
    reason: null,
    evidenceDueDate: null,
    recovery: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("POST /disputes", () => {
  it("records an inbound chargeback", async () => {
    prisma.dispute.findUnique.mockResolvedValue(null);
    prisma.dispute.create.mockResolvedValue(disputeRow());

    const res = await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ providerDisputeId: "dispute-vps-1", provider: "VPS", amount: 10000 });

    expect(res.status).toBe(201);
    expect(res.body.amountCents).toBe(10000);
    expect(res.body.status).toBe("OPEN");
  });

  it("replays idempotently by providerDisputeId", async () => {
    prisma.dispute.findUnique.mockResolvedValue(disputeRow());

    const res = await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ providerDisputeId: "dispute-vps-1", provider: "VPS", amount: 10000 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("dispute-1");
    expect(prisma.dispute.create).not.toHaveBeenCalled();
  });
});

describe("GET /disputes", () => {
  it("lists disputes", async () => {
    prisma.dispute.findMany.mockResolvedValue([disputeRow()]);

    const res = await request(app).get("/disputes").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].amountCents).toBe(10000);
  });
});

describe("GET /disputes/:id", () => {
  it("returns 404 when the dispute is missing", async () => {
    prisma.dispute.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/disputes/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DISPUTE_NOT_FOUND");
  });
});

describe("POST /disputes/:id/resolve", () => {
  it("resolves to WON with no money movement", async () => {
    prisma.dispute.findFirst.mockResolvedValue(disputeRow());
    prisma.dispute.update.mockResolvedValue(disputeRow({ status: "WON" }));

    const res = await request(app)
      .post("/disputes/dispute-1/resolve")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ outcome: "WON" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("WON");
  });

  it("resolves to LOST and records an uncovered recovery", async () => {
    prisma.dispute.findFirst.mockResolvedValue(disputeRow());
    prisma.ledgerEntry.findMany.mockResolvedValue([]); // zero balances
    prisma.settlementPolicy.findFirst.mockResolvedValue(null); // default policy
    prisma.dispute.update.mockResolvedValue(disputeRow({ status: "LOST" }));
    prisma.recovery.create.mockResolvedValue({
      id: "recovery-1",
      tenantId: "tenant-a",
      disputeId: "dispute-1",
      status: "PENDING",
      amount: "100.00",
      currency: "MAD",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/disputes/dispute-1/resolve")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ outcome: "LOST" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("LOST");
    expect(res.body.recovery).not.toBeNull();
    expect(res.body.recovery.amountCents).toBe(10000);
  });
});

describe("auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/disputes");
    expect(res.status).toBe(401);
  });
});
