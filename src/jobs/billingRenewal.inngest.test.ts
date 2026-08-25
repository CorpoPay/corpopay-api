import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    subscription: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../lib/dunning", () => ({
  chargeSubscription: vi.fn(),
  runDunningLadder: vi.fn(),
}));

vi.mock("../lib/inngest", () => ({
  inngest: {
    createFunction: vi.fn((_o: unknown, _t: unknown, handler: unknown) => handler),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

import { runDunningLadder } from "../lib/dunning";
import { prisma } from "../lib/prisma";
import { billingRenewal } from "./billingRenewal.inngest";

const mockFindSub = prisma.subscription.findUniqueOrThrow as ReturnType<typeof vi.fn>;
const mockUpdateSub = prisma.subscription.update as ReturnType<typeof vi.fn>;

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      subscriptionId: "sub-1",
      tenantId: "tenant-a",
      customerId: "cust-1",
      amount: 9900, // centimes
      currency: "MAD",
      intervalType: "MONTHLY",
      intervalValue: 1,
      chargeId: "renewal-1",
      idempotencyId: "sub-1-2026-02-01",
      attemptNumber: 1,
      ...overrides,
    },
  };
}

function makeStep() {
  return { run: vi.fn(async (_n: string, fn: () => unknown) => fn()), sendEvent: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSub.mockResolvedValue({});
});

describe("billingRenewal", () => {
  it.each(["CANCELLED", "EXPIRED", "PAUSED"])(
    "skips when the subscription is %s",
    async (status) => {
      mockFindSub.mockResolvedValue({ id: "sub-1", status });
      const result = await (billingRenewal as Function)({
        event: makeEvent(),
        step: makeStep(),
        runId: "run-1",
      });
      expect(result).toEqual({ skipped: true, reason: `Subscription is ${status}` });
      expect(runDunningLadder).not.toHaveBeenCalled();
    },
  );

  it("stores the Inngest run id and delegates to the dunning ladder for an ACTIVE subscription", async () => {
    mockFindSub.mockResolvedValue({ id: "sub-1", status: "ACTIVE" });
    (runDunningLadder as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

    const result = await (billingRenewal as Function)({
      event: makeEvent(),
      step: makeStep(),
      runId: "run-1",
    });

    expect(result).toEqual({ success: true });
    expect(mockUpdateSub).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: { inngestRunId: "run-1" },
    });

    const config = (runDunningLadder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(config.maxAttempts).toBe(4);
    expect(config.delays).toEqual(["1d", "2d", "4d"]);
    expect(typeof config.attempt).toBe("function");
    expect(typeof config.onSuccess).toBe("function");
    expect(typeof config.onExhausted).toBe("function");
  });
});
