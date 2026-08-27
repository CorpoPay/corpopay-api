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

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "recon-report-1",
    tenantId: "tenant-a",
    provider: "VPS",
    currency: "MAD",
    periodStart: null,
    periodEnd: null,
    status: "PENDING",
    summary: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "recon-line-1",
    reportId: "recon-report-1",
    reference: "payout-1",
    amount: "100.00",
    currency: "MAD",
    status: "UNMATCHED",
    matchedAmount: null,
    differenceAmount: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("reconciliation reports", () => {
  it("POST /reconciliation-reports creates a report with lines", async () => {
    prisma.reconciliationReport.create.mockResolvedValue({
      ...reportRow(),
      lines: [lineRow()],
    });

    const res = await request(app)
      .post("/reconciliation-reports")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        provider: "VPS",
        lines: [{ reference: "payout-1", amountCents: 10000 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.lines).toHaveLength(1);
    expect(prisma.reconciliationReport.create).toHaveBeenCalled();
  });

  it("POST /reconciliation-reports rejects an empty line list", async () => {
    const res = await request(app)
      .post("/reconciliation-reports")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ provider: "VPS", lines: [] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(prisma.reconciliationReport.create).not.toHaveBeenCalled();
  });

  it("GET /reconciliation-reports lists reports", async () => {
    prisma.reconciliationReport.findMany.mockResolvedValue([
      { ...reportRow(), lines: [lineRow()] },
    ]);

    const res = await request(app)
      .get("/reconciliation-reports")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].lines[0].amountCents).toBe(10000);
  });

  it("GET /reconciliation-reports/:id returns 404 for a missing report", async () => {
    prisma.reconciliationReport.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/reconciliation-reports/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("RECONCILIATION_NOT_FOUND");
  });

  it("POST /reconciliation-reports/:id/run matches an exact ledger posting", async () => {
    prisma.reconciliationReport.findFirst.mockResolvedValueOnce({
      ...reportRow(),
      lines: [lineRow()],
    }); // pre-run read (the post-run report is read via findUnique below)
    prisma.ledgerEntry.findMany.mockResolvedValue([{ sourceId: "payout-1", amount: "100.00" }]);
    prisma.reconciliationLine.update.mockResolvedValue(
      lineRow({ status: "EXACT", matchedAmount: "100.00", differenceAmount: "0.00" }),
    );
    prisma.reconciliationReport.update.mockResolvedValue(reportRow({ status: "MATCHED" }));
    prisma.reconciliationReport.findUnique.mockResolvedValue({
      ...reportRow({ status: "MATCHED" }),
      lines: [lineRow({ status: "EXACT", matchedAmount: "100.00", differenceAmount: "0.00" })],
    });

    const res = await request(app)
      .post("/reconciliation-reports/recon-report-1/run")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("MATCHED");
    expect(res.body.lines[0].status).toBe("EXACT");
  });

  it("POST /reconciliation-reports/:id/resolve closes a report", async () => {
    prisma.reconciliationReport.findFirst
      .mockResolvedValueOnce({ ...reportRow({ status: "UNMATCHED" }), lines: [lineRow()] }) // resolve read
      .mockResolvedValueOnce({ ...reportRow({ status: "RESOLVED" }), lines: [lineRow()] }); // re-fetch
    prisma.reconciliationReport.update.mockResolvedValue(reportRow({ status: "RESOLVED" }));

    const res = await request(app)
      .post("/reconciliation-reports/recon-report-1/resolve")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("RESOLVED");
  });
});

describe("auth", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/reconciliation-reports");
    expect(res.status).toBe(401);
  });
});
