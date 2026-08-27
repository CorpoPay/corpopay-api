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

function partyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "split-party-1",
    slug: "host-1",
    name: "Host 1",
    type: "SUB_MERCHANT",
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "split-rule-1",
    name: "Marketplace split",
    trigger: "AT_CAPTURE",
    shares: [{ partyId: "split-party-1", shareBps: 8000 }],
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function splitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "split-1",
    splitRuleId: null,
    sourceType: "payment_intent",
    sourceId: "intent-1",
    partyId: "split-party-1",
    amount: "80.00",
    currency: "MAD",
    status: "SETTLED",
    heldUntil: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("split parties", () => {
  it("POST /split-parties creates a beneficiary", async () => {
    prisma.splitParty.create.mockResolvedValue(partyRow());

    const res = await request(app)
      .post("/split-parties")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ slug: "host-1", name: "Host 1" });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("host-1");
    expect(prisma.splitParty.create).toHaveBeenCalled();
  });

  it("GET /split-parties lists beneficiaries", async () => {
    prisma.splitParty.findMany.mockResolvedValue([partyRow()]);

    const res = await request(app)
      .get("/split-parties")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("GET /split-parties/:id returns 404 for a missing party", async () => {
    prisma.splitParty.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/split-parties/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SPLIT_PARTY_NOT_FOUND");
  });

  it("POST /split-parties/:id/deactivate deactivates a party", async () => {
    prisma.splitParty.findFirst.mockResolvedValue(partyRow());
    prisma.splitParty.update.mockResolvedValue(partyRow({ isActive: false }));

    const res = await request(app)
      .post("/split-parties/split-party-1/deactivate")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });
});

describe("split rules", () => {
  it("POST /split-rules creates a template", async () => {
    prisma.splitRule.create.mockResolvedValue(ruleRow());

    const res = await request(app)
      .post("/split-rules")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ name: "Marketplace split", shares: [{ partyId: "split-party-1", shareBps: 8000 }] });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Marketplace split");
    expect(prisma.splitRule.create).toHaveBeenCalled();
  });

  it("POST /split-rules rejects shares that exceed 10000 bps", async () => {
    const res = await request(app)
      .post("/split-rules")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        name: "Bad rule",
        shares: [
          { partyId: "p1", shareBps: 6000 },
          { partyId: "p2", shareBps: 5000 },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(prisma.splitRule.create).not.toHaveBeenCalled();
  });

  it("GET /split-rules lists templates", async () => {
    prisma.splitRule.findMany.mockResolvedValue([ruleRow()]);

    const res = await request(app)
      .get("/split-rules")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("GET /split-rules/:id returns 404 for a missing rule", async () => {
    prisma.splitRule.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/split-rules/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SPLIT_RULE_NOT_FOUND");
  });
});

describe("splits", () => {
  it("POST /splits executes an inline split (AT_CAPTURE)", async () => {
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
    prisma.ledgerEntry.create.mockResolvedValue({
      id: "le-1",
      postingId: "posting-1",
      account: "AVAILABLE",
      direction: "CREDIT",
      amount: "80.00",
      balanceAfter: "80.00",
      partyId: "split-party-1",
    });
    prisma.split.create.mockResolvedValue(splitRow());

    const res = await request(app)
      .post("/splits")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        sourceType: "payment_intent",
        sourceId: "intent-1",
        sourceCents: 10000,
        shares: [{ partyId: "split-party-1", shareBps: 8000 }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].amountCents).toBe(8000);
    expect(res.body[0].partyId).toBe("split-party-1");
  });

  it("GET /splits lists executions", async () => {
    prisma.split.findMany.mockResolvedValue([splitRow()]);

    const res = await request(app).get("/splits").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].amountCents).toBe(8000);
  });

  it("GET /splits/:id returns 404 for a missing split", async () => {
    prisma.split.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/splits/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SPLIT_NOT_FOUND");
  });

  it("POST /splits/:id/release releases a held split", async () => {
    prisma.split.findFirst
      .mockResolvedValueOnce(splitRow({ status: "PENDING" }))
      .mockResolvedValueOnce(splitRow({ status: "PENDING" }));
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
    prisma.ledgerEntry.create.mockResolvedValue({
      id: "le-rel",
      postingId: "posting-2",
      account: "AVAILABLE",
      direction: "CREDIT",
      amount: "80.00",
      balanceAfter: "80.00",
      partyId: "split-party-1",
    });
    prisma.split.update.mockResolvedValue(splitRow({ status: "SETTLED", heldUntil: null }));

    const res = await request(app)
      .post("/splits/split-1/release")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SETTLED");
  });

  it("POST /splits/:id/release returns 404 for a missing split", async () => {
    prisma.split.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/splits/missing/release")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SPLIT_NOT_FOUND");
  });
});

describe("auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/splits");
    expect(res.status).toBe(401);
  });
});
