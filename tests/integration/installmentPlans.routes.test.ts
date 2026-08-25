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

const mockFindMany = prisma.installmentPlan.findMany as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.installmentPlan.findFirst as ReturnType<typeof vi.fn>;
const mockCreate = prisma.installmentPlan.create as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.installmentPlan.update as ReturnType<typeof vi.fn>;
const mockDelete = prisma.installmentPlan.delete as ReturnType<typeof vi.fn>;
const mockCountAgreement = prisma.installmentAgreement.count as ReturnType<typeof vi.fn>;

const PLAN = {
  id: "plan-1",
  tenantId: "tenant-a",
  name: "Pay in 3",
  durationMonths: 3,
  annualInterestRate: 0,
  minAmount: null,
  maxAmount: null,
  isActive: true,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(PLAN);
  mockCreate.mockResolvedValue(PLAN);
  mockUpdate.mockResolvedValue(PLAN);
  mockDelete.mockResolvedValue(PLAN);
  mockCountAgreement.mockResolvedValue(0);
});

describe("installment plans routes", () => {
  it("lists plans", async () => {
    mockFindMany.mockResolvedValue([{ ...PLAN, _count: { agreements: 0 } }]);
    const res = await request(app)
      .get("/installment-plans")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("creates a plan", async () => {
    const res = await request(app)
      .post("/installment-plans")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ name: "Pay in 6", durationMonths: 6, annualInterestRate: 12.99 });
    expect(res.status).toBe(201);
  });

  it("rejects a negative APR", async () => {
    const res = await request(app)
      .post("/installment-plans")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ name: "Bad", durationMonths: 3, annualInterestRate: -1 });
    expect(res.status).toBe(422);
  });

  it("updates a plan", async () => {
    const res = await request(app)
      .patch("/installment-plans/plan-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
  });

  it("deletes a plan with no active agreements", async () => {
    const res = await request(app)
      .delete("/installment-plans/plan-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("blocks deleting a plan with active agreements", async () => {
    mockCountAgreement.mockResolvedValue(1);
    const res = await request(app)
      .delete("/installment-plans/plan-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(409);
  });
});

describe("GET /public/installment-plans/:slug", () => {
  it("returns plan previews for an installment link", async () => {
    prisma.paymentLink.findFirst.mockResolvedValue({
      id: "link-1",
      slug: "link-1",
      isInstallment: true,
      amount: "1500.00",
      currency: "MAD",
      tenant: { id: "tenant-a", status: "ACTIVE" },
    });
    mockFindMany.mockResolvedValue([{ ...PLAN, annualInterestRate: 8.99 }]);

    const res = await request(app).get("/public/installment-plans/link-1");
    expect(res.status).toBe(200);
    expect(res.body.principal).toBe(1500);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].installmentAmount).toBeGreaterThan(0);
  });

  it("returns 400 for a non-installment link", async () => {
    prisma.paymentLink.findFirst.mockResolvedValue({
      id: "link-1",
      slug: "link-1",
      isInstallment: false,
      amount: "100.00",
      tenant: { id: "tenant-a", status: "ACTIVE" },
    });
    const res = await request(app).get("/public/installment-plans/link-1");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_INSTALLMENT");
  });
});
