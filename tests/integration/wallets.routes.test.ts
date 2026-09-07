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

const walletRow = (overrides: Record<string, unknown> = {}) => ({
  id: "wallet-1",
  tenantId: "tenant-a",
  ownerType: "CUSTOMER",
  ownerId: "customer-1",
  balance: 0,
  currency: "MAD",
  status: "ACTIVE",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const txRow = (overrides: Record<string, unknown> = {}) => ({
  id: "wallet-tx-1",
  walletId: "wallet-1",
  tenantId: "tenant-a",
  type: "TOP_UP",
  amount: 100,
  currency: "MAD",
  balanceAfter: 100,
  sourceType: "wallet_topup",
  sourceId: "wallet-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const ledgerEntryRow = (data: Record<string, unknown>) => ({
  id: "le-1",
  postingId: "p-1",
  account: data.account,
  direction: data.direction,
  amount: data.amount,
  balanceAfter: data.balanceAfter ?? data.amount,
  partyId: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.ledgerEntry.groupBy.mockResolvedValue([]);
  prisma.ledgerEntry.create.mockImplementation(async ({ data }) => ledgerEntryRow(data));
});

describe("wallets routes", () => {
  it("creates a wallet (idempotent upsert)", async () => {
    prisma.wallet.upsert.mockResolvedValue(walletRow({ balance: 0 }));

    const res = await request(app)
      .post("/wallets")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ ownerType: "CUSTOMER", ownerId: "customer-1" });

    expect(res.status).toBe(201);
    expect(res.body.ownerType).toBe("CUSTOMER");
    expect(res.body.balanceCents).toBe(0);
  });

  it("lists wallets", async () => {
    prisma.wallet.findMany.mockResolvedValue([walletRow({ balance: 5000 })]);

    const res = await request(app).get("/wallets").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].balanceCents).toBe(500000);
  });

  it("gets a wallet with its transactions", async () => {
    prisma.wallet.findFirst.mockResolvedValue({
      ...walletRow({ balance: 100 }),
      transactions: [txRow()],
    });

    const res = await request(app)
      .get("/wallets/wallet-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].amountCents).toBe(10000);
  });

  it("returns 404 for a missing wallet", async () => {
    prisma.wallet.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/wallets/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });

  it("tops up a wallet", async () => {
    prisma.wallet.findFirst.mockResolvedValue(walletRow({ balance: 0 }));
    prisma.walletTransaction.create.mockResolvedValue(
      txRow({ type: "TOP_UP", amount: 100, balanceAfter: 100 }),
    );
    prisma.wallet.update.mockResolvedValue(walletRow({ balance: 100 }));

    const res = await request(app)
      .post("/wallets/wallet-1/topup")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ amountCents: 10000, paymentIntentId: "pi_1" });

    expect(res.status).toBe(200);
    expect(res.body.balanceCents).toBe(10000);
    expect(res.body.transaction.type).toBe("TOP_UP");
  });

  it("tops up with a commission on the load basis", async () => {
    prisma.financeConfig.findUnique.mockResolvedValue({ walletCommissionBasis: "load" });
    prisma.wallet.findFirst.mockResolvedValue(walletRow({ balance: 0 }));
    prisma.feeSchedule.findFirst.mockResolvedValue({
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 290,
      perMethodCents: null,
      tiersCents: null,
    });
    prisma.settlementPolicy.findFirst.mockResolvedValue(null);
    prisma.walletTransaction.create.mockResolvedValue(
      txRow({ type: "TOP_UP", amount: 97.1, balanceAfter: 97.1 }),
    );
    prisma.wallet.update.mockResolvedValue(walletRow({ balance: 97.1 }));

    const res = await request(app)
      .post("/wallets/wallet-1/topup")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ amountCents: 10000 });

    expect(res.status).toBe(200);
    // 100.00 MAD − 2.9% (2.90 MAD) = 97.10 MAD credited.
    expect(res.body.balanceCents).toBe(9710);
  });

  it("debits a wallet and records commission", async () => {
    prisma.wallet.findFirst.mockResolvedValue(walletRow({ balance: 1000 }));
    prisma.feeSchedule.findFirst.mockResolvedValue({
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 290,
      perMethodCents: null,
      tiersCents: null,
    });
    prisma.walletTransaction.create.mockResolvedValue(
      txRow({ type: "DEBIT", amount: -100, balanceAfter: 900 }),
    );
    prisma.wallet.update.mockResolvedValue(walletRow({ balance: 900 }));

    const res = await request(app)
      .post("/wallets/wallet-1/debit")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ amountCents: 10000, method: "wallet" });

    expect(res.status).toBe(200);
    expect(res.body.transaction.type).toBe("DEBIT");
    expect(res.body.balanceCents).toBe(90000);
  });

  it("rejects a debit that exceeds the balance (409)", async () => {
    prisma.wallet.findFirst.mockResolvedValue(walletRow({ balance: 0 }));
    prisma.feeSchedule.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/wallets/wallet-1/debit")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ amountCents: 10000 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WALLET_INSUFFICIENT_BALANCE");
  });

  it("refunds a wallet", async () => {
    prisma.wallet.findFirst.mockResolvedValue(walletRow({ balance: 100 }));
    prisma.walletTransaction.create.mockResolvedValue(
      txRow({ type: "REFUND", amount: 50, balanceAfter: 150 }),
    );
    prisma.wallet.update.mockResolvedValue(walletRow({ balance: 150 }));

    const res = await request(app)
      .post("/wallets/wallet-1/refund")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ amountCents: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.balanceCents).toBe(15000);
  });

  it("adjusts a wallet (signed)", async () => {
    prisma.wallet.findFirst.mockResolvedValue(walletRow({ balance: 100 }));
    prisma.walletTransaction.create.mockResolvedValue(
      txRow({ type: "ADJUSTMENT", amount: -20, balanceAfter: 80 }),
    );
    prisma.wallet.update.mockResolvedValue(walletRow({ balance: 80 }));

    const res = await request(app)
      .post("/wallets/wallet-1/adjust")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ amountCents: -2000 });

    expect(res.status).toBe(200);
    expect(res.body.balanceCents).toBe(8000);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/wallets");
    expect(res.status).toBe(401);
  });
});
