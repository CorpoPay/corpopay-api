import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    installmentAgreement: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../lib/dunning", () => ({
  chargeInstallment: vi.fn(),
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
import { installmentCharge } from "./installmentCharge.inngest";

const mockFindAgreement = prisma.installmentAgreement.findUniqueOrThrow as ReturnType<typeof vi.fn>;
const mockUpdateAgreement = prisma.installmentAgreement.update as ReturnType<typeof vi.fn>;

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      agreementId: "agreement-1",
      installmentNumber: 2,
      tenantId: "tenant-a",
      chargeId: "inst-2",
      idempotencyId: "agreement-1-inst-2",
      ...overrides,
    },
  };
}

function makeStep() {
  return { run: vi.fn(async (_n: string, fn: () => unknown) => fn()), sendEvent: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateAgreement.mockResolvedValue({});
});

describe("installmentCharge", () => {
  it.each(["CANCELLED", "COMPLETED", "DEFAULTED"])(
    "skips when the agreement is %s",
    async (status) => {
      mockFindAgreement.mockResolvedValue({ id: "agreement-1", status });
      const result = await (installmentCharge as Function)({
        event: makeEvent(),
        step: makeStep(),
        runId: "run-1",
      });
      expect(result).toEqual({ skipped: true, reason: `Agreement is ${status}` });
      expect(runDunningLadder).not.toHaveBeenCalled();
    },
  );

  it("stores the run id and delegates to the dunning ladder for an ACTIVE agreement", async () => {
    mockFindAgreement.mockResolvedValue({ id: "agreement-1", status: "ACTIVE" });
    (runDunningLadder as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

    const result = await (installmentCharge as Function)({
      event: makeEvent(),
      step: makeStep(),
      runId: "run-1",
    });

    expect(result).toEqual({ success: true });
    expect(mockUpdateAgreement).toHaveBeenCalledWith({
      where: { id: "agreement-1" },
      data: { inngestRunId: "run-1" },
    });

    const config = (runDunningLadder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(config.maxAttempts).toBe(4);
    expect(config.delays).toEqual(["1d", "2d", "4d"]);
  });
});
