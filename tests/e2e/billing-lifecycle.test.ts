/**
 * E2E: recurring + installment billing entry points.
 *
 * Covers the public pay flow's billing branches that the per-router tests skip:
 *   - a recurring link passes `storePaymentProfile: true` to the provider;
 *   - an installment link requires a plan, computes the down payment, and
 *     creates a PENDING_CHECKOUT agreement.
 */
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

const fakeAdapter = {
  createCheckoutSession: vi.fn(async (params: { correlationId: string }) => ({
    redirectUrl: "https://checkout.example/pay",
    providerRef: params.correlationId,
    providerData: {},
    rawRequest: {},
    rawResponse: {},
  })),
};
vi.mock("../../src/adapters/registry", () => ({ getAdapter: vi.fn(() => fakeAdapter) }));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";

const recurringLink = {
  id: "link-rec",
  tenantId: "tenant-a",
  tenant: { id: "tenant-a", status: "ACTIVE" },
  slug: "link-rec",
  provider: "VPS",
  status: "ACTIVE",
  amount: "99.00",
  currency: "MAD",
  reference: "REF-REC",
  description: "Monthly subscription",
  maxAttempts: 1,
  attemptCount: 0,
  isInstallment: false,
  isRecurring: true,
  customerEmail: null,
  customerName: null,
  customerPhone: null,
};

const installmentLink = {
  ...recurringLink,
  id: "link-inst",
  slug: "link-inst",
  isRecurring: false,
  isInstallment: true,
  amount: "1500.00",
  reference: "REF-INST",
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.providerConfig.findFirst.mockResolvedValue({
    id: "cfg",
    status: "CONNECTED",
    encryptedCredentials: "v2:{}",
  });
  prisma.paymentLink.updateMany.mockResolvedValue({ count: 1 });
  prisma.paymentIntent.create.mockResolvedValue({
    id: "intent-1",
    tenantId: "tenant-a",
    correlationId: "corr-1",
    provider: "VPS",
    status: "CREATED",
  });
  prisma.paymentIntent.update.mockResolvedValue({});
  prisma.providerTransaction.create.mockResolvedValue({});
});

describe("recurring checkout", () => {
  it("passes storePaymentProfile:true to the provider", async () => {
    prisma.paymentLink.findFirst.mockResolvedValue(recurringLink);
    const res = await request(app).post("/public/checkout/link-rec/pay").send({});
    expect(res.status).toBe(200);
    expect(fakeAdapter.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ storePaymentProfile: true }),
    );
  });
});

describe("installment checkout", () => {
  it("requires a plan on an installment link", async () => {
    prisma.paymentLink.findFirst.mockResolvedValue(installmentLink);
    const res = await request(app).post("/public/checkout/link-inst/pay").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PLAN_REQUIRED");
  });

  it("creates a PENDING_CHECKOUT agreement and charges the down payment", async () => {
    prisma.paymentLink.findFirst.mockResolvedValue(installmentLink);
    prisma.installmentPlan.findFirst.mockResolvedValue({
      id: "plan-1",
      tenantId: "tenant-a",
      name: "Pay in 3",
      durationMonths: 3,
      annualInterestRate: 0,
      isActive: true,
      minAmount: null,
      maxAmount: null,
    });
    prisma.installmentAgreement.create.mockResolvedValue({
      id: "agreement-1",
      tenantId: "tenant-a",
      status: "PENDING_CHECKOUT",
    });

    const res = await request(app)
      .post("/public/checkout/link-inst/pay")
      .send({ installmentPlanId: "plan-1" });

    expect(res.status).toBe(200);
    expect(res.body.agreementId).toBe("agreement-1");
    // storePaymentProfile is required to keep the stored card for future charges.
    expect(fakeAdapter.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ storePaymentProfile: true }),
    );
  });
});
