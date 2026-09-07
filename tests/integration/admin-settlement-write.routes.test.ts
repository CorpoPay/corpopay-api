import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
// Mock the tenant-scoped settlement write helpers — these endpoints delegate to
// them cross-tenant, so we assert the delegation (correct tenantId) without
// re-running the full money logic (already covered by the lib/unit suites).
vi.mock("../../src/lib/reversals-db", () => ({ resolveDispute: vi.fn() }));
vi.mock("../../src/lib/reconciliation-db", () => ({ resolveReconciliation: vi.fn() }));
vi.mock("../../src/lib/statements-db", () => ({ finalizeSettlementStatement: vi.fn() }));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { resolveReconciliation } from "../../src/lib/reconciliation-db";
import { resolveDispute } from "../../src/lib/reversals-db";
import { finalizeSettlementStatement } from "../../src/lib/statements-db";
import { mintToken } from "../factories";

const ADMIN_TOKEN = mintToken({ id: "user-admin", tenantId: "tenant-a", role: "SUPER_ADMIN" });
const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockResolveDispute = resolveDispute as ReturnType<typeof vi.fn>;
const mockResolveReconciliation = resolveReconciliation as ReturnType<typeof vi.fn>;
const mockFinalizeStatement = finalizeSettlementStatement as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("POST /admin/disputes/:id/resolve", () => {
  it("resolves a dispute for any tenant (cross-tenant delegation)", async () => {
    prisma.dispute.findUnique.mockResolvedValue({ id: "dispute-1", tenantId: "tenant-b" });
    mockResolveDispute.mockResolvedValue({ id: "dispute-1", status: "WON", updatedAt: new Date() });

    const res = await request(app)
      .post("/admin/disputes/dispute-1/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ outcome: "WON" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "dispute-1", status: "WON", updatedAt: expect.any(String) });
    expect(mockResolveDispute).toHaveBeenCalledWith("tenant-b", "dispute-1", "WON");
  });

  it("returns 404 for a missing dispute", async () => {
    prisma.dispute.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/admin/disputes/missing/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ outcome: "WON" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DISPUTE_NOT_FOUND");
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });

  it("rejects an invalid outcome", async () => {
    const res = await request(app)
      .post("/admin/disputes/dispute-1/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ outcome: "DRAW" });
    expect(res.status).toBe(422);
    expect(mockResolveDispute).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    const res = await request(app)
      .post("/admin/disputes/dispute-1/resolve")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ outcome: "WON" });
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/reconciliation-reports/:id/resolve", () => {
  it("closes a report for any tenant (cross-tenant delegation)", async () => {
    prisma.reconciliationReport.findUnique.mockResolvedValue({
      id: "rec-1",
      tenantId: "tenant-b",
      status: "RESOLVED",
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/admin/reconciliation-reports/rec-1/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "rec-1", status: "RESOLVED", updatedAt: expect.any(String) });
    expect(mockResolveReconciliation).toHaveBeenCalledWith("tenant-b", "rec-1");
  });

  it("returns 404 for a missing report", async () => {
    prisma.reconciliationReport.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/admin/reconciliation-reports/missing/resolve")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("RECONCILIATION_NOT_FOUND");
    expect(mockResolveReconciliation).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    const res = await request(app)
      .post("/admin/reconciliation-reports/rec-1/resolve")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/settlement-statements/:id/finalize", () => {
  it("finalizes a statement for any tenant (cross-tenant delegation)", async () => {
    prisma.settlementStatement.findUnique.mockResolvedValue({
      id: "stmt-1",
      tenantId: "tenant-b",
      status: "FINALIZED",
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/admin/settlement-statements/stmt-1/finalize")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "stmt-1",
      status: "FINALIZED",
      updatedAt: expect.any(String),
    });
    expect(mockFinalizeStatement).toHaveBeenCalledWith("tenant-b", "stmt-1");
  });

  it("returns 404 for a missing statement", async () => {
    prisma.settlementStatement.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/admin/settlement-statements/missing/finalize")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STATEMENT_NOT_FOUND");
    expect(mockFinalizeStatement).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    const res = await request(app)
      .post("/admin/settlement-statements/stmt-1/finalize")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});
