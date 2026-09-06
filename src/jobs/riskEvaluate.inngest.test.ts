import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    paymentIntent: { findUnique: vi.fn() },
    riskDecision: { count: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("../lib/inngest", () => ({
  inngest: { createFunction: vi.fn((_opts: unknown, handler: unknown) => handler) },
}));

import { prisma } from "../lib/prisma";
import { riskEvaluate } from "./riskEvaluate.inngest";

const mockFindIntent = prisma.paymentIntent.findUnique as ReturnType<typeof vi.fn>;
const mockCount = prisma.riskDecision.count as ReturnType<typeof vi.fn>;
const mockUpsert = prisma.riskDecision.upsert as ReturnType<typeof vi.fn>;

const EVENT = { data: { intentId: "intent-1", tenantId: "tenant-a" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockUpsert.mockResolvedValue({ id: "risk-decision-1" });
});

describe("riskEvaluate", () => {
  it("derives the amount from a linked PaymentLink and records an ALLOW decision", async () => {
    mockFindIntent.mockResolvedValue({ paymentLink: { amount: "100.00" }, metadata: null });

    const result = await (riskEvaluate as Function)({ event: EVENT });

    expect(mockFindIntent).toHaveBeenCalledWith({
      where: { id: "intent-1" },
      include: { paymentLink: { select: { amount: true } } },
    });
    expect(mockCount).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "intent-1" },
        create: expect.objectContaining({ tenantId: "tenant-a", verdict: "ALLOW", score: 0 }),
      }),
    );
    expect(result).toMatchObject({ verdict: "ALLOW", score: 0, decisionId: "risk-decision-1" });
  });

  it("derives the amount from direct-intent metadata centimes", async () => {
    mockFindIntent.mockResolvedValue({ paymentLink: null, metadata: { amount: 10050 } });

    const result = await (riskEvaluate as Function)({ event: EVENT });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ verdict: "ALLOW", score: 0 }),
      }),
    );
    expect(result).toMatchObject({ verdict: "ALLOW" });
  });

  it("skips when the intent is not found", async () => {
    mockFindIntent.mockResolvedValue(null);

    const result = await (riskEvaluate as Function)({ event: EVENT });

    expect(result).toEqual({ skipped: true, reason: "intent-not-found" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("skips when the amount cannot be determined", async () => {
    mockFindIntent.mockResolvedValue({ paymentLink: null, metadata: null });

    const result = await (riskEvaluate as Function)({ event: EVENT });

    expect(result).toEqual({ skipped: true, reason: "amount-unknown" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
