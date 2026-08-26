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

const mockLedgerFindMany = prisma.ledgerEntry.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  mockLedgerFindMany.mockResolvedValue([]);
});

describe("GET /ledger", () => {
  it("derives per-account balances and the balance invariant from entries", async () => {
    mockLedgerFindMany.mockResolvedValue([
      {
        id: "e1",
        postingId: "p1",
        account: "CASH",
        direction: "DEBIT",
        category: "CAPTURE",
        amount: "1000.00",
        balanceAfter: "-1000.00",
        sourceType: null,
        sourceId: null,
        createdAt: new Date(),
      },
      {
        id: "e2",
        postingId: "p1",
        account: "COLLECTED",
        direction: "CREDIT",
        category: "CAPTURE",
        amount: "1000.00",
        balanceAfter: "1000.00",
        sourceType: null,
        sourceId: null,
        createdAt: new Date(),
      },
    ]);

    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.balances.CASH).toBe(-1000);
    expect(res.body.balances.COLLECTED).toBe(1000);
    expect(res.body.balances.AVAILABLE).toBe(0);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0].amount).toBe(1000);
  });

  it("returns a zeroed, balanced ledger when no entries exist", async () => {
    const res = await request(app).get("/ledger").set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.entries).toEqual([]);
    expect(res.body.balances.CASH).toBe(0);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/ledger");
    expect(res.status).toBe(401);
  });
});
