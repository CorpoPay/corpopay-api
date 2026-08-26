import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

vi.mock("../../src/adapters/registry", () => ({
  getAdapter: vi.fn(),
}));

import { getAdapter } from "../../src/adapters/registry";
import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "payout-1",
    status: "DRAFT",
    provider: "VPS",
    method: "BANK_TRANSFER",
    currency: "MAD",
    amount: "100.00",
    feeAmount: "0.00",
    providerTransferId: null,
    idempotencyKey: "payout-idem-1",
    items: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("POST /payouts", () => {
  it("snapshots eligible AVAILABLE funds into a DRAFT payout", async () => {
    prisma.payout.findUnique.mockResolvedValue(null);
    prisma.ledgerEntry.findMany.mockResolvedValue([{ id: "le-1", amount: "100.00" }]);
    prisma.payout.create.mockResolvedValue(
      payoutRow({ items: [{ id: "pi-1", ledgerEntryId: "le-1", amount: "100.00" }] }),
    );

    const res = await request(app)
      .post("/payouts")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ idempotencyKey: "payout-idem-1", provider: "VPS" });

    expect(res.status).toBe(201);
    expect(res.body.amountCents).toBe(10000);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].ledgerEntryId).toBe("le-1");
  });

  it("replays idempotently (same idempotencyKey → same payout)", async () => {
    prisma.payout.findUnique.mockResolvedValue(payoutRow());
    prisma.ledgerEntry.findMany.mockResolvedValue([{ id: "le-1", amount: "100.00" }]);

    const res = await request(app)
      .post("/payouts")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ idempotencyKey: "payout-idem-1", provider: "VPS" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("payout-1");
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });
});

describe("GET /payouts", () => {
  it("lists payouts for the tenant", async () => {
    prisma.payout.findMany.mockResolvedValue([payoutRow()]);

    const res = await request(app).get("/payouts").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].amountCents).toBe(10000);
  });
});

describe("GET /payouts/:id", () => {
  it("returns a payout", async () => {
    prisma.payout.findFirst.mockResolvedValue(payoutRow());

    const res = await request(app)
      .get("/payouts/payout-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("payout-1");
  });

  it("returns 404 when the payout is missing", async () => {
    prisma.payout.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/payouts/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PAYOUT_NOT_FOUND");
  });
});

describe("POST /payouts/:id/cancel", () => {
  it("cancels a DRAFT payout", async () => {
    prisma.payout.findFirst
      .mockResolvedValueOnce(payoutRow())
      .mockResolvedValueOnce(payoutRow({ status: "CANCELLED" }));
    prisma.payout.update.mockResolvedValue(payoutRow({ status: "CANCELLED" }));

    const res = await request(app)
      .post("/payouts/payout-1/cancel")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });
});

describe("POST /payouts/:id/process", () => {
  it("disburses via the provider and settles the ledger", async () => {
    prisma.payout.findFirst
      .mockResolvedValueOnce(payoutRow())
      .mockResolvedValueOnce(payoutRow())
      .mockResolvedValueOnce(payoutRow({ status: "PAID", providerTransferId: "tr-1" }));
    prisma.providerConfig.findFirst.mockResolvedValue({
      provider: "VPS",
      encryptedCredentials: "enc",
    });
    (getAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      createPayout: vi.fn().mockResolvedValue({ success: true, providerTransferId: "tr-1" }),
    });
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
    prisma.ledgerEntry.create.mockResolvedValue({
      id: "le-paid",
      postingId: "posting-1",
      account: "AVAILABLE",
      direction: "DEBIT",
      amount: "100.00",
      balanceAfter: "-100.00",
    });
    prisma.payout.update.mockResolvedValue(
      payoutRow({ status: "PAID", providerTransferId: "tr-1" }),
    );

    const res = await request(app)
      .post("/payouts/payout-1/process")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PAID");
    expect(res.body.providerTransferId).toBe("tr-1");
  });

  it("returns 400 when the provider is not configured", async () => {
    prisma.payout.findFirst.mockResolvedValue(payoutRow());
    prisma.providerConfig.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/payouts/payout-1/process")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("marks the payout failed and returns 502 on provider failure", async () => {
    prisma.payout.findFirst.mockResolvedValueOnce(payoutRow()).mockResolvedValueOnce(payoutRow());
    prisma.providerConfig.findFirst.mockResolvedValue({
      provider: "VPS",
      encryptedCredentials: "enc",
    });
    (getAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      createPayout: vi.fn().mockResolvedValue({ success: false }),
    });
    prisma.payout.update.mockResolvedValue(payoutRow({ status: "FAILED" }));

    const res = await request(app)
      .post("/payouts/payout-1/process")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PAYOUT_FAILED");
  });
});

describe("auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/payouts");
    expect(res.status).toBe(401);
  });
});
