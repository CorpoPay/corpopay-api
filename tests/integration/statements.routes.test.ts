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

function statementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "statement-1",
    tenantId: "tenant-a",
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
    currency: "MAD",
    status: "DRAFT",
    openingBalance: "0.00",
    closingBalance: "100.00",
    netAmount: "100.00",
    finalizedAt: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "statement-item-1",
    statementId: "statement-1",
    category: "CAPTURE",
    amount: "100.00",
    entryCount: 1,
    createdAt: new Date("2026-02-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("settlement statements", () => {
  it("POST /settlement-statements snapshots the ledger", async () => {
    prisma.ledgerEntry.findMany.mockResolvedValue([]);
    prisma.settlementStatement.create.mockResolvedValue({
      ...statementRow(),
      items: [itemRow()],
    });

    const res = await request(app)
      .post("/settlement-statements")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ periodStart: "2026-01-01T00:00:00Z", periodEnd: "2026-02-01T00:00:00Z" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.netCents).toBe(10000);
    expect(prisma.settlementStatement.create).toHaveBeenCalled();
  });

  it("POST /settlement-statements rejects an inverted period", async () => {
    const res = await request(app)
      .post("/settlement-statements")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ periodStart: "2026-02-01T00:00:00Z", periodEnd: "2026-01-01T00:00:00Z" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(prisma.settlementStatement.create).not.toHaveBeenCalled();
  });

  it("GET /settlement-statements lists statements", async () => {
    prisma.settlementStatement.findMany.mockResolvedValue([
      { ...statementRow(), items: [itemRow()] },
    ]);

    const res = await request(app)
      .get("/settlement-statements")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].items[0].amountCents).toBe(10000);
  });

  it("GET /settlement-statements/:id returns 404 for a missing statement", async () => {
    prisma.settlementStatement.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/settlement-statements/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STATEMENT_NOT_FOUND");
  });

  it("POST /settlement-statements/:id/finalize locks a statement", async () => {
    prisma.settlementStatement.findFirst
      .mockResolvedValueOnce({ ...statementRow(), items: [itemRow()] }) // finalize read
      .mockResolvedValueOnce({
        ...statementRow({ status: "FINALIZED", finalizedAt: new Date("2026-02-02T00:00:00Z") }),
        items: [itemRow()],
      }); // re-fetch
    prisma.settlementStatement.update.mockResolvedValue(
      statementRow({ status: "FINALIZED", finalizedAt: new Date("2026-02-02T00:00:00Z") }),
    );

    const res = await request(app)
      .post("/settlement-statements/statement-1/finalize")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FINALIZED");
    expect(res.body.finalizedAt).not.toBeNull();
  });

  it("POST /settlement-statements/:id/void voids a statement", async () => {
    prisma.settlementStatement.findFirst
      .mockResolvedValueOnce({ ...statementRow(), items: [itemRow()] })
      .mockResolvedValueOnce({ ...statementRow({ status: "VOID" }), items: [itemRow()] });
    prisma.settlementStatement.update.mockResolvedValue(statementRow({ status: "VOID" }));

    const res = await request(app)
      .post("/settlement-statements/statement-1/void")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("VOID");
  });
});

describe("auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/settlement-statements");
    expect(res.status).toBe(401);
  });
});
