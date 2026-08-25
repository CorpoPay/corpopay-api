import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    paymentIntent: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    providerTransaction: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    paymentLink: { update: vi.fn() },
    webhookEvent: { create: vi.fn() },
  },
}));

vi.mock("../lib/inngest", () => ({
  inngest: {
    createFunction: vi.fn((_opts: unknown, handler: unknown) => handler),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

import { prisma } from "../lib/prisma";
import { stripeWebhookProcessor } from "./stripeWebhookProcessor.inngest";

const mockFindFirst = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.paymentIntent.findUnique as ReturnType<typeof vi.fn>;
const mockUpdateIntent = prisma.paymentIntent.update as ReturnType<typeof vi.fn>;
const mockWebhookCreate = prisma.webhookEvent.create as ReturnType<typeof vi.fn>;

const FAKE_INTENT = {
  id: "intent-1",
  tenantId: "tenant-a",
  status: "REQUIRES_ACTION",
  paymentLinkId: "link-1",
};

function makeEvent(eventType: string, object: Record<string, unknown>) {
  return {
    data: {
      payloadJson: { id: "evt_1", type: eventType, data: { object } },
      rawBodyBase64: Buffer.from("{}").toString("base64"),
      headers: {},
      idempotencyKey: "evt_1",
    },
  };
}

function makeStep() {
  return { run: vi.fn(async (_n: string, fn: () => unknown) => fn()), sendEvent: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWebhookCreate.mockResolvedValue({ id: "wh-1" });
  mockUpdateIntent.mockResolvedValue({});
  (prisma.providerTransaction.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.paymentLink.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

describe("stripeWebhookProcessor", () => {
  it("skips cleanly when the intent cannot be resolved", async () => {
    mockFindFirst.mockResolvedValue(null);
    const result = await (stripeWebhookProcessor as Function)({
      event: makeEvent("payment_intent.succeeded", { object: "payment_intent", id: "pi_unknown" }),
      step: makeStep(),
    });
    expect(result).toMatchObject({ skipped: true, reason: "intent-not-found" });
  });

  it("resolves the intent via metadata.correlationId and maps success", async () => {
    mockFindFirst.mockResolvedValue({ ...FAKE_INTENT });
    mockFindUnique.mockResolvedValue({ status: "REQUIRES_ACTION" });

    const result = await (stripeWebhookProcessor as Function)({
      event: makeEvent("payment_intent.succeeded", {
        object: "payment_intent",
        id: "pi_1",
        metadata: { correlationId: "corr-1" },
      }),
      step: makeStep(),
    });

    expect(result).toMatchObject({ newStatus: "SUCCEEDED" });
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ correlationId: "corr-1" }) }),
    );
    expect(mockUpdateIntent).toHaveBeenCalledWith({
      where: { id: "intent-1" },
      data: { status: "SUCCEEDED" },
    });
  });

  it.each([
    ["payment_intent.payment_failed", "FAILED"],
    ["payment_intent.canceled", "CANCELED"],
  ])("maps %s → %s", async (eventType, status) => {
    mockFindFirst.mockResolvedValue({ ...FAKE_INTENT });
    mockFindUnique.mockResolvedValue({ status: "REQUIRES_ACTION" });

    const result = await (stripeWebhookProcessor as Function)({
      event: makeEvent(eventType, {
        object: "payment_intent",
        id: "pi_1",
        metadata: { correlationId: "corr-1" },
      }),
      step: makeStep(),
    });

    expect(result).toMatchObject({ newStatus: status });
  });

  it("maps charge.refunded → REFUNDED", async () => {
    mockFindFirst.mockResolvedValue({ ...FAKE_INTENT, status: "SUCCEEDED" });
    mockFindUnique.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await (stripeWebhookProcessor as Function)({
      event: makeEvent("charge.refunded", {
        object: "charge",
        id: "ch_1",
        metadata: { correlationId: "corr-1" },
      }),
      step: makeStep(),
    });

    expect(result).toMatchObject({ newStatus: "REFUNDED" });
  });

  it("skips unhandled event types", async () => {
    mockFindFirst.mockResolvedValue({ ...FAKE_INTENT });
    const result = await (stripeWebhookProcessor as Function)({
      event: makeEvent("payment_intent.created", {
        object: "payment_intent",
        id: "pi_1",
        metadata: { correlationId: "corr-1" },
      }),
      step: makeStep(),
    });
    expect(result).toMatchObject({ skipped: true, reason: "unhandled-event-type" });
  });

  it("does not overwrite a terminal SUCCEEDED state with a non-REFUNDED terminal state", async () => {
    mockFindFirst.mockResolvedValue({ ...FAKE_INTENT, status: "SUCCEEDED" });
    mockFindUnique.mockResolvedValue({ status: "SUCCEEDED" });

    await (stripeWebhookProcessor as Function)({
      event: makeEvent("payment_intent.succeeded", {
        object: "payment_intent",
        id: "pi_1",
        metadata: { correlationId: "corr-1" },
      }),
      step: makeStep(),
    });

    expect(mockUpdateIntent).not.toHaveBeenCalled();
  });
});
