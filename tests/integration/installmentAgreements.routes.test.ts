import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
vi.mock("../../src/config/inngest", () => ({
  inngestHandler: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../src/lib/inngest", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockFindMany = prisma.installmentAgreement.findMany as ReturnType<typeof vi.fn>;
const mockCount = prisma.installmentAgreement.count as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.installmentAgreement.findFirst as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.installmentAgreement.update as ReturnType<typeof vi.fn>;

const AGREEMENT = {
  id: "agreement-1",
  tenantId: "tenant-a",
  customerId: "cust-1",
  plan: { name: "Pay in 3", durationMonths: 3, annualInterestRate: 0 },
  status: "ACTIVE",
  principalAmount: "1500.00",
  downPayment: "500.00",
  installmentAmount: "500.00",
  totalInstallments: 3,
  paidCount: 1,
  currency: "MAD",
  nextChargeDate: new Date(),
  encryptedStoredProfileId: "v2:secret",
  inngestRunId: null,
  installmentCharges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockFindFirst.mockResolvedValue(AGREEMENT);
  mockUpdate.mockResolvedValue(AGREEMENT);
});

describe("installment agreements routes", () => {
  it("lists agreements", async () => {
    mockFindMany.mockResolvedValue([{ ...AGREEMENT, _count: { installmentCharges: 3 } }]);
    const res = await request(app)
      .get("/installment-agreements")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("returns detail without exposing the encrypted profile id or run id", async () => {
    const res = await request(app)
      .get("/installment-agreements/agreement-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.encryptedStoredProfileId).toBeUndefined();
    expect(res.body.inngestRunId).toBeUndefined();
    expect(res.body.principalAmount).toBe(1500);
  });

  it("cancels an ACTIVE agreement", async () => {
    mockUpdate.mockResolvedValue({ id: "agreement-1", status: "CANCELLED" });
    const res = await request(app)
      .post("/installment-agreements/agreement-1/cancel")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });

  it("rejects cancelling a COMPLETED agreement", async () => {
    mockFindFirst.mockResolvedValue({ ...AGREEMENT, status: "COMPLETED" });
    const res = await request(app)
      .post("/installment-agreements/agreement-1/cancel")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(400);
  });
});
