/**
 * webhookProcessor.inngest.test.ts
 *
 * Unit tests for the webhook-processor Inngest function, focused on the
 * `find-intent` step — the lookup logic that caused the March 2026 incident.
 *
 * We do NOT spin up a real Inngest runtime. Instead, we extract the inner
 * handler function and call it directly, feeding a mock `step` object whose
 * `step.run()` executes the callback synchronously (no queueing).  This gives
 * full control over every Prisma call and lets us assert which DB path was
 * taken without any network traffic.
 *
 * Covered paths (exactly what broke):
 *   1. correlationId  — payload.customerId → PaymentIntent.correlationId
 *   2. metadata.reference — payload.orderId  → PaymentIntent.metadata.reference
 *   3. unknown chargeId   — both lookups miss  → intent is null → signatureVerified false
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

vi.mock("../lib/prisma", () => ({
  prisma: {
    paymentIntent: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    providerConfig: {
      findFirst: vi.fn(),
    },
    webhookEvent: {
      create: vi.fn(),
    },
    providerTransaction: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    paymentLink: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    installmentAgreement: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    installmentCharge: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// ─── Mock Inngest client ──────────────────────────────────────────────────────
// We intercept createFunction so we can capture the handler, and mock send()
// so bootstrap-subscription / send-payment-notification steps don't throw.

vi.mock("../lib/inngest", () => ({
  inngest: {
    createFunction: vi.fn((_opts: unknown, handler: unknown) => handler),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Mock adapter registry ────────────────────────────────────────────────────

vi.mock("../adapters/registry", () => ({
  getAdapter: vi.fn(() => ({
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
    mapStatusToInternal: vi.fn(() => "SUCCEEDED"),
  })),
}));

// ─── Mock encryption (not under test here) ───────────────────────────────────

vi.mock("../lib/encryption", () => ({
  encrypt: vi.fn((s: string) => `v2:${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^v2:/, "")),
  encryptCredentials: vi.fn((o: object) => `v2:${JSON.stringify(o)}`),
  decryptCredentials: vi.fn(() => ({
    notificationKey: "test-notification-key-32-chars!!",
    callbackTestMode: false,
  })),
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────

import { getAdapter } from "../adapters/registry";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

// webhookProcessor's module-level side-effect calls inngest.createFunction and
// assigns the result. Because our mock returns the raw handler, importing the
// module gives us the handler directly.
import { webhookProcessor } from "./webhookProcessor.inngest";

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mockFindFirstIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindFirstConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockWebhookCreate = prisma.webhookEvent.create as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;

// ─── Step emulator ────────────────────────────────────────────────────────────
//
// Mimics the Inngest step API: step.run(name, fn) just awaits fn().
// step.sendEvent(name, event) delegates to inngest.send() so we can assert on it.

function makeStep() {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn(async (_name: string, event: unknown) => mockInngestSend(event)),
  };
}

// ─── Fixture data ─────────────────────────────────────────────────────────────

const FAKE_INTENT = {
  id: "cmmp09m9q000211x972nsld5z",
  tenantId: "tenant-acme-id",
  correlationId: "cmmp09m9q000311x9d9is81yr",
  providerRef: "cmmp09m9q000311x9d9is81yr",
  provider: "VPS",
  status: "REQUIRES_ACTION",
  paymentLinkId: null,
  metadata: {},
  paymentLink: null,
};

const FAKE_CONFIG = {
  id: "config-vps-id",
  tenantId: "tenant-acme-id",
  provider: "VPS",
  encryptedCredentials: "v2:{}",
  status: "CONNECTED",
};

/**
 * Build a minimal event payload as the HTTP route sends it to Inngest.
 * rawBodyBase64 is the base64 of the JSON-serialised payloadJson.
 */
function makeEvent(
  payloadJson: Record<string, unknown>,
  headerOverrides: Record<string, string> = {},
) {
  const raw = Buffer.from(JSON.stringify(payloadJson)).toString("base64");
  return {
    data: {
      provider: "VPS" as const,
      payloadJson,
      rawBodyBase64: raw,
      headers: {
        "content-type": "application/json",
        "x-callback-signature": "valid-sig",
        ...headerOverrides,
      },
      idempotencyKey: "idem-key-001",
      signatureVerified: true,
    },
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("webhookProcessor — find-intent step", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: config always resolves (so verify-signature step doesn't short-circuit)
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);

    // Default: webhookEvent.create resolves with a stub record
    mockWebhookCreate.mockResolvedValue({ id: "webhook-event-001" });

    // Default: paymentIntent.update resolves (update-intent-status step)
    (prisma.paymentIntent.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_INTENT,
      status: "SUCCEEDED",
    });

    // Default: no existing provider transaction
    (prisma.providerTransaction.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Default: paymentLink.findUnique returns null (not a recurring link)
    (prisma.paymentLink.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Default: no existing subscription
    (prisma.subscription.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Default: adapter verifies successfully and maps to SUCCEEDED
    (getAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      verifyWebhookSignature: vi.fn().mockReturnValue(true),
      mapStatusToInternal: vi.fn(() => "SUCCEEDED"),
    });
  });

  // ── Path 1 — correlationId ──────────────────────────────────────────────────

  it("resolves the intent via correlationId when customerId is present in payload", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });

    const event = makeEvent({
      id: "txn-001",
      customerId: FAKE_INTENT.correlationId,
      status: "CHARGED",
      merchantAccount: "Int_acme_Test",
    });

    const step = makeStep();
    const result = await (webhookProcessor as Function)({ event, step });

    // Handler should complete without throwing
    expect(result).toMatchObject({ processed: true });

    // The first (and only) findFirst call must target correlationId
    expect(mockFindFirstIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          correlationId: FAKE_INTENT.correlationId,
        }),
      }),
    );
  });

  it("does NOT fall through to metadata.reference when correlationId lookup succeeds", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId, // should be used first
      orderId: "some-booking-ref", // also present — must be ignored
      status: "CHARGED",
    });

    const step = makeStep();
    await (webhookProcessor as Function)({ event, step });

    // Only one DB lookup needed — the correlationId one
    expect(mockFindFirstIntent).toHaveBeenCalledOnce();
  });

  // ── Path 2 — metadata.reference ────────────────────────────────────────────

  it("falls back to metadata.reference lookup when correlationId misses", async () => {
    const bookingRequestId = "69b4222e19645b6d2644af53";

    // No customerId in payload → correlationId lookup is SKIPPED (conditional).
    // First call  (providerRef)        → no match
    // Second call (metadata.reference) → match
    mockFindFirstIntent
      .mockResolvedValueOnce(null) // providerRef
      .mockResolvedValueOnce({ ...FAKE_INTENT, paymentLink: null }); // metadata.reference

    const event = makeEvent({
      id: "txn-002",
      orderId: bookingRequestId, // no customerId — the Acme / Payzone echo path
      status: "CHARGED",
    });

    const step = makeStep();
    const result = await (webhookProcessor as Function)({ event, step });

    expect(result).toMatchObject({ processed: true });

    // Second call must use the metadata.reference path
    expect(mockFindFirstIntent).toHaveBeenCalledTimes(2);
    const secondCall = mockFindFirstIntent.mock.calls[1][0] as {
      where: { metadata: { path: string[]; equals: unknown } };
    };
    expect(secondCall.where.metadata).toBeDefined();
    expect(secondCall.where.metadata.equals).toBe(bookingRequestId);
  });

  it("resolves the intent when orderId carries the bookingRequestId (Payzone echo path)", async () => {
    // This is the canonical Acme flow: Payzone echoes the bookingRequestId
    // back as orderId. customerId is absent, so correlationId lookup is skipped.
    const bookingRequestId = "aabbccddeeff001122334455";

    // No customerId → correlationId lookup skipped.
    // First call  (providerRef)        → no match
    // Second call (metadata.reference) → match
    mockFindFirstIntent
      .mockResolvedValueOnce(null) // providerRef
      .mockResolvedValueOnce({ ...FAKE_INTENT, paymentLink: null }); // metadata.reference

    const event = makeEvent({
      orderId: bookingRequestId, // echoed back by Payzone
      status: "CHARGED",
    });

    const step = makeStep();
    const result = await (webhookProcessor as Function)({ event, step });

    expect(result).toMatchObject({ processed: true });

    // Second (metadata.reference) lookup must use the orderId value
    expect(mockFindFirstIntent).toHaveBeenCalledTimes(2);
    const secondCall = mockFindFirstIntent.mock.calls[1][0] as {
      where: { metadata: { equals: unknown } };
    };
    expect(secondCall.where.metadata.equals).toBe(bookingRequestId);
  });

  // ── Path 3 — both lookups miss → intent is null ────────────────────────────

  it("returns processed:false when no intent is found via any lookup path", async () => {
    // All three lookups miss
    mockFindFirstIntent.mockResolvedValue(null);

    const event = makeEvent({
      id: "txn-unknown",
      orderId: "completely-unknown-ref",
      status: "CHARGED",
    });

    const step = makeStep();
    const result = await (webhookProcessor as Function)({ event, step });

    // No intent → tenantId is null → signatureVerified = false → processed = false
    expect(result).toMatchObject({ processed: false });
  });

  it("returns processed:false and does not enqueue payment/notify when intent is null", async () => {
    mockFindFirstIntent.mockResolvedValue(null);

    const event = makeEvent({
      orderId: "ghost-booking-ref",
      status: "CHARGED",
    });

    const step = makeStep();
    await (webhookProcessor as Function)({ event, step });

    // sendEvent (payment/notify) must NOT have been called
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  // ── Payload field priority ──────────────────────────────────────────────────

  it("prefers customerId over orderId for the correlationId lookup", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId, // should be used first
      orderId: "some-other-ref",
      status: "CHARGED",
    });

    const step = makeStep();
    await (webhookProcessor as Function)({ event, step });

    // First lookup must use customerId as correlationId
    const firstCall = mockFindFirstIntent.mock.calls[0][0] as {
      where: { correlationId: string };
    };
    expect(firstCall.where.correlationId).toBe(FAKE_INTENT.correlationId);
  });

  it("treats OrderID (uppercase) as orderId for the orderId extraction", async () => {
    const bookingRef = "uppercase-order-id-ref";

    // No customerId → correlationId lookup skipped.
    // First call  (providerRef)        → no match
    // Second call (metadata.reference) → match
    mockFindFirstIntent
      .mockResolvedValueOnce(null) // providerRef
      .mockResolvedValueOnce({ ...FAKE_INTENT, paymentLink: null }); // metadata.ref

    // Some VPS callbacks capitalise the key
    const event = makeEvent({ OrderID: bookingRef, status: "CHARGED" });

    const step = makeStep();
    await (webhookProcessor as Function)({ event, step });

    // Second call (metadata.reference) must have received the uppercase value
    expect(mockFindFirstIntent).toHaveBeenCalledTimes(2);
    const secondCall = mockFindFirstIntent.mock.calls[1][0] as {
      where: { metadata: { equals: string } };
    };
    expect(secondCall.where.metadata.equals).toBe(bookingRef);
  });

  // ── Signature verify step wiring ────────────────────────────────────────────

  it("verify-signature step returns false when tenantId is null (no intent found)", async () => {
    mockFindFirstIntent.mockResolvedValue(null);
    mockFindFirstConfig.mockResolvedValue(null);

    const event = makeEvent({ orderId: "no-match", status: "CHARGED" });

    // Spy on step.run to capture the verify-signature callback's return value
    const stepRunResults: Record<string, unknown> = {};
    const step = {
      run: vi.fn(async (name: string, fn: () => unknown) => {
        const result = await fn();
        stepRunResults[name] = result;
        return result;
      }),
      sendEvent: vi.fn(),
    };

    await (webhookProcessor as Function)({ event, step });

    expect(stepRunResults["verify-signature"]).toBe(false);
  });

  it("verify-signature step returns true when config is found and adapter verifies", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    (getAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      verifyWebhookSignature: vi.fn().mockReturnValue(true),
      mapStatusToInternal: vi.fn(() => "SUCCEEDED"),
    });

    const stepRunResults: Record<string, unknown> = {};
    const step = {
      run: vi.fn(async (name: string, fn: () => unknown) => {
        const result = await fn();
        stepRunResults[name] = result;
        return result;
      }),
      sendEvent: vi.fn(),
    };

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId,
      status: "CHARGED",
    });

    await (webhookProcessor as Function)({ event, step });

    expect(stepRunResults["verify-signature"]).toBe(true);
  });

  it("verify-signature step returns false when config is missing even if intent is found", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });
    mockFindFirstConfig.mockResolvedValue(null); // config missing

    const stepRunResults: Record<string, unknown> = {};
    const step = {
      run: vi.fn(async (name: string, fn: () => unknown) => {
        const result = await fn();
        stepRunResults[name] = result;
        return result;
      }),
      sendEvent: vi.fn(),
    };

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId,
      status: "CHARGED",
    });

    await (webhookProcessor as Function)({ event, step });

    expect(stepRunResults["verify-signature"]).toBe(false);
  });

  it("verify-signature step returns false when adapter throws", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    (getAdapter as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("decryption failed");
    });

    const stepRunResults: Record<string, unknown> = {};
    const step = {
      run: vi.fn(async (name: string, fn: () => unknown) => {
        const result = await fn();
        stepRunResults[name] = result;
        return result;
      }),
      sendEvent: vi.fn(),
    };

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId,
      status: "CHARGED",
    });

    await (webhookProcessor as Function)({ event, step });

    // catch block inside the step returns false
    expect(stepRunResults["verify-signature"]).toBe(false);
  });

  // ── store-webhook-event step ────────────────────────────────────────────────

  it("always calls store-webhook-event, even when intent is null", async () => {
    mockFindFirstIntent.mockResolvedValue(null);

    const event = makeEvent({ orderId: "no-match", status: "CHARGED" });
    const step = makeStep();

    await (webhookProcessor as Function)({ event, step });

    expect(mockWebhookCreate).toHaveBeenCalledOnce();
    const createArg = mockWebhookCreate.mock.calls[0][0] as {
      data: {
        provider: string;
        signatureVerified: boolean;
        paymentIntentId: null;
      };
    };
    expect(createArg.data.provider).toBe("VPS");
    expect(createArg.data.signatureVerified).toBe(false);
    expect(createArg.data.paymentIntentId).toBeNull();
  });

  it("passes the correct idempotencyKey into store-webhook-event", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId,
      status: "CHARGED",
    });
    const step = makeStep();

    await (webhookProcessor as Function)({ event, step });

    const createArg = mockWebhookCreate.mock.calls[0][0] as {
      data: { idempotencyKey: string };
    };
    expect(createArg.data.idempotencyKey).toBe("idem-key-001");
  });

  // ── Return value ────────────────────────────────────────────────────────────

  it("returns the webhookEventId from store-webhook-event", async () => {
    mockFindFirstIntent.mockResolvedValue({
      ...FAKE_INTENT,
      paymentLink: null,
    });
    mockWebhookCreate.mockResolvedValue({ id: "whe-abc-999" });

    const event = makeEvent({
      customerId: FAKE_INTENT.correlationId,
      status: "CHARGED",
    });
    const step = makeStep();

    const result = await (webhookProcessor as Function)({ event, step });

    expect((result as { webhookEventId: string }).webhookEventId).toBe("whe-abc-999");
  });
});
