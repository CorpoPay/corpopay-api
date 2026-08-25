import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    subscription: { findMany: vi.fn() },
  },
}));

vi.mock("../lib/inngest", () => ({
  inngest: {
    createFunction: vi.fn((_o: unknown, _t: unknown, handler: unknown) => handler),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";
import { billingDailySweep } from "./billingDailySweep.inngest";

const mockFindMany = prisma.subscription.findMany as ReturnType<typeof vi.fn>;
const mockSend = inngest.send as ReturnType<typeof vi.fn>;

function makeStep() {
  return { run: vi.fn(async (_n: string, fn: () => unknown) => fn()) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billingDailySweep", () => {
  it("returns dispatched:0 when no subscriptions are due", async () => {
    mockFindMany.mockResolvedValue([]);
    const result = await (billingDailySweep as Function)({ step: makeStep() });
    expect(result).toEqual({ dispatched: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("dispatches a renewal event per due subscription with a stable idempotency key", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "sub-1",
        tenantId: "tenant-a",
        customerId: "cust-1",
        amount: "99.00",
        currency: "MAD",
        intervalType: "MONTHLY",
        intervalValue: 1,
        nextBillingDate: new Date("2026-02-01T00:00:00Z"),
      },
    ]);

    const result = await (billingDailySweep as Function)({ step: makeStep() });

    expect(result).toEqual({ dispatched: 1 });
    expect(mockSend).toHaveBeenCalledOnce();
    const events = mockSend.mock.calls[0][0];
    expect(events[0].name).toBe("billing/renewal.due");
    expect(events[0].id).toBe("sub-1-2026-02-01");
    // Money invariant: MAD Decimal is converted to centimes (99.00 → 9900).
    expect(events[0].data.amount).toBe(9900);
  });
});
