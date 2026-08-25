/**
 * webhooks.route.test.ts
 *
 * Integration tests for POST /webhooks/vps using supertest.
 * Prisma, inngest, and the adapter are fully mocked — no DB, no network.
 *
 * Covers every branch in handleWebhook() that caused or could cause a 401:
 *   - lookup by correlationId (customerId field)
 *   - lookup by metadata.reference (orderId/chargeId field) — the incident fix
 *   - no chargeId in payload
 *   - intent not found
 *   - provider config not found
 *   - signature mismatch
 *   - valid signature → 200 + Inngest enqueue
 *   - duplicate idempotency key → 200 deduplicated
 */
import crypto from "crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock Prisma ──────────────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest — factory functions must
// use inline vi.fn() rather than referencing variables declared in module scope.

vi.mock("../lib/prisma", () => ({
  prisma: {
    paymentIntent: {
      findFirst: vi.fn(),
    },
    providerConfig: {
      findFirst: vi.fn(),
    },
    webhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// ─── Mock Inngest ─────────────────────────────────────────────────────────────

vi.mock("../lib/inngest", () => ({
  inngest: {
    send: vi.fn().mockResolvedValue(undefined),
    createFunction: vi.fn(),
  },
}));

// ─── Mock Inngest handler (so serve() never runs against the mocked client) ──

vi.mock("../config/inngest", () => ({
  inngestHandler: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ─── Mock adapter registry ────────────────────────────────────────────────────

vi.mock("../adapters/registry", () => ({
  getAdapter: vi.fn(() => ({
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
    mapStatusToInternal: vi.fn(() => "SUCCEEDED"),
  })),
}));

// ─── Mock encryption ─────────────────────────────────────────────────────────

vi.mock("../lib/encryption", () => ({
  encrypt: vi.fn((s: string) => `v2:${s}`),
  decrypt: vi.fn((s: string) => s.replace("v2:", "")),
  encryptCredentials: vi.fn((o: object) => `v2:${JSON.stringify(o)}`),
  decryptCredentials: vi.fn(() => ({
    notificationKey: "test-notification-key",
    callbackTestMode: false,
  })),
}));

// ─── Import app + mocked modules AFTER vi.mock calls ─────────────────────────

import { getAdapter } from "../adapters/registry";
import app from "../app";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

// Typed references to the auto-mocked functions for use in tests
const mockFindFirstIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindFirstConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockFindUniqueWebhook = prisma.webhookEvent.findUnique as ReturnType<typeof vi.fn>;
const mockInngestSend = inngest.send as ReturnType<typeof vi.fn>;
// verifyWebhookSignature lives on the object returned by getAdapter() — grab it after each reset
function getMockVerify(): ReturnType<typeof vi.fn> {
  return (getAdapter as ReturnType<typeof vi.fn>).mock.results[
    (getAdapter as ReturnType<typeof vi.fn>).mock.results.length - 1
  ]?.value?.verifyWebhookSignature as ReturnType<typeof vi.fn>;
}

// Mutable reference — re-pointed in beforeEach after getAdapter is re-wired
let mockVerifyWebhookSignature: ReturnType<typeof vi.fn>;

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTIFICATION_KEY = "test-notification-key";

const FAKE_INTENT = {
  id: "cmmp09m9q000211x972nsld5z",
  tenantId: "tenant-acme-id",
  correlationId: "cmmp09m9q000311x9d9is81yr",
  providerRef: "cmmp09m9q000311x9d9is81yr",
  provider: "VPS",
  status: "REQUIRES_ACTION",
};

const FAKE_CONFIG = {
  id: "config-vps-id",
  tenantId: "tenant-acme-id",
  provider: "VPS",
  encryptedCredentials: "v2:{}",
  status: "CONNECTED",
};

/**
 * Build a minimal Payzone-style VPS callback payload.
 * orderId  = bookingRequestId (what Acme sends as reference)
 * customerId = correlationId (what CorpoPay generates internally)
 */
function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "vps-transaction-id-001",
    orderId: "69b4222e19645b6d2644af53", // bookingRequestId
    customerId: "cmmp09m9q000311x9d9is81yr", // correlationId
    internalId: "internal-001",
    status: "CHARGED",
    merchantAccount: "Int_acme_Test",
    ...overrides,
  };
}

/**
 * Produce a valid HMAC-SHA256 hex signature over a raw body buffer,
 * mimicking what Payzone sends in X-Callback-Signature.
 */
function sign(body: Buffer | string, key: string = NOTIFICATION_KEY): string {
  return crypto.createHmac("sha256", key).update(body).digest("hex");
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire getAdapter mock to return a fresh adapter object each test.
  // The adapter object is created eagerly here so that mockVerifyWebhookSignature
  // points to the exact vi.fn() instance that getAdapter() will return.
  const freshVerify = vi.fn().mockReturnValue(true);
  const freshMapStatus = vi.fn(() => "SUCCEEDED");
  (getAdapter as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    verifyWebhookSignature: freshVerify,
    mapStatusToInternal: freshMapStatus,
  }));

  // Expose the verify fn so individual tests can override its return value
  // without having to re-mock the entire getAdapter call.
  mockVerifyWebhookSignature = freshVerify;

  // Default: no existing webhook event (not a duplicate)
  mockFindUniqueWebhook.mockResolvedValue(null);

  // Default: Inngest send succeeds
  mockInngestSend.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helper: POST /webhooks/vps ───────────────────────────────────────────────

function post(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const sig = sign(Buffer.from(body));

  return request(app)
    .post("/webhooks/vps")
    .set("Content-Type", "application/json")
    .set("x-callback-signature", sig)
    .set(headers)
    .send(body);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /webhooks/vps", () => {
  // ── 400 bad JSON ──────────────────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    const res = await request(app)
      .post("/webhooks/vps")
      .set("Content-Type", "application/json")
      .send("not-json{{");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid JSON payload");
  });

  // ── 401 — no chargeId in payload ──────────────────────────────────────────

  it("returns 401 when payload contains no orderId, customerId, or chargeId", async () => {
    const payload = { status: "CHARGED", merchantAccount: "Int_acme_Test" };
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post("/webhooks/vps")
      .set("Content-Type", "application/json")
      .set("x-callback-signature", sign(Buffer.from(body)))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SIGNATURE_INVALID");
  });

  // ── 401 — intent not found by correlationId ───────────────────────────────

  it("returns 401 when correlationId lookup finds nothing and no reference fallback", async () => {
    mockFindFirstIntent.mockResolvedValue(null);

    const payload = makePayload({
      orderId: undefined,
      customerId: "unknown-correlation-id",
    });
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post("/webhooks/vps")
      .set("Content-Type", "application/json")
      .set("x-callback-signature", sign(Buffer.from(body)))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SIGNATURE_INVALID");
  });

  // ── 401 — provider config not found ──────────────────────────────────────

  it("returns 401 when intent is found but provider config is missing", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(null);

    const res = await post(makePayload());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SIGNATURE_INVALID");
  });

  // ── 401 — signature mismatch ──────────────────────────────────────────────

  it("returns 401 when adapter.verifyWebhookSignature returns false", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    (getAdapter as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      verifyWebhookSignature: vi.fn().mockReturnValue(false),
      mapStatusToInternal: vi.fn(() => "SUCCEEDED"),
    }));

    const res = await post(makePayload());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SIGNATURE_INVALID");
  });

  it("returns 401 when the x-callback-signature header is missing entirely", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    (getAdapter as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      verifyWebhookSignature: vi.fn().mockReturnValue(false),
      mapStatusToInternal: vi.fn(() => "SUCCEEDED"),
    }));

    const body = JSON.stringify(makePayload());
    const res = await request(app)
      .post("/webhooks/vps")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
  });

  // ── 200 — lookup by correlationId (customerId field) ─────────────────────

  it("returns 200 when intent is found via correlationId (customerId in payload)", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    mockVerifyWebhookSignature.mockReturnValue(true);

    const res = await post(makePayload({ customerId: FAKE_INTENT.correlationId }));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  // ── 200 — lookup by metadata.reference (orderId = bookingRequestId) ───────
  //
  // THIS IS THE INCIDENT FIX — Payzone echoes back orderId = bookingRequestId,
  // not the correlationId. The first DB lookup (by correlationId) must miss,
  // and the second (by metadata.reference) must succeed.

  it("returns 200 when intent is found via metadata.reference fallback (orderId = bookingRequestId)", async () => {
    const bookingRequestId = "69b4222e19645b6d2644af53";

    // First call (by correlationId) → miss
    // Second call (by metadata.reference) → hit
    mockFindFirstIntent
      .mockResolvedValueOnce(null) // correlationId lookup misses
      .mockResolvedValueOnce(FAKE_INTENT); // metadata.reference lookup hits

    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    mockVerifyWebhookSignature.mockReturnValue(true);

    // Payload where customerId is absent — only orderId present
    const payload = makePayload({
      customerId: undefined,
      orderId: bookingRequestId,
      chargeId: bookingRequestId,
    });
    const res = await post(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Verify the second DB call used the metadata.reference path
    expect(mockFindFirstIntent).toHaveBeenCalledTimes(2);
    const secondCall = mockFindFirstIntent.mock.calls[1][0];
    expect(secondCall.where.metadata).toBeDefined();
    expect(secondCall.where.metadata.equals ?? secondCall.where.metadata?.path).toBeDefined();
  });

  it("returns 200 when chargeId field matches metadata.reference", async () => {
    const bookingRequestId = "69b4222e19645b6d2644af53";

    mockFindFirstIntent.mockResolvedValueOnce(null).mockResolvedValueOnce(FAKE_INTENT);

    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    mockVerifyWebhookSignature.mockReturnValue(true);

    const payload = makePayload({
      customerId: undefined,
      orderId: undefined,
      chargeId: bookingRequestId,
    });
    const res = await post(payload);

    expect(res.status).toBe(200);
  });

  // ── 200 — Inngest is enqueued on success ──────────────────────────────────

  it("sends a webhook/process event to Inngest on successful verification", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    // getAdapter default (from beforeEach) returns verifyWebhookSignature → true

    await post(makePayload());

    expect(mockInngestSend).toHaveBeenCalledOnce();
    const [sentEvent] = mockInngestSend.mock.calls[0];
    expect(sentEvent.name).toBe("webhook/process");
    expect(sentEvent.data.provider).toBe("VPS");
    expect(sentEvent.data.signatureVerified).toBe(true);
    expect(typeof sentEvent.data.rawBodyBase64).toBe("string");
  });

  // ── 200 — idempotency dedup ───────────────────────────────────────────────

  it("returns 200 with duplicate:true and does NOT enqueue Inngest for a duplicate event", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    // getAdapter default returns verifyWebhookSignature → true

    // Simulate existing webhook event with same idempotency key
    mockFindUniqueWebhook.mockResolvedValue({
      id: "existing-webhook-event-id",
    });

    const res = await post(makePayload());
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  // ── Provider isolation — VPS route rejects NAPS intents ──────────────────

  it("returns 401 when the intent found belongs to a different provider", async () => {
    // All lookups return null because the provider filter (VPS) won't match NAPS intent
    mockFindFirstIntent.mockResolvedValue(null);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);

    const res = await post(makePayload());
    expect(res.status).toBe(401);
  });

  // ── Exception handling ────────────────────────────────────────────────────

  it("returns 401 (not 500) when Prisma throws during intent lookup", async () => {
    mockFindFirstIntent.mockRejectedValue(new Error("DB connection lost"));

    const res = await post(makePayload());
    // The catch block in handleWebhook means we get 401, not 500
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SIGNATURE_INVALID");
  });

  // ── idempotencyKey derivation — eventId field ─────────────────────────────

  it("uses payload.eventId as idempotency key when present", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockFindUniqueWebhook.mockResolvedValue(null);

    const payload = makePayload({ eventId: "payzone-event-abc123" });
    await post(payload);

    expect(mockFindUniqueWebhook).toHaveBeenCalledWith({
      where: { idempotencyKey: "payzone-event-abc123" },
    });
  });

  it("falls back to SHA-256(rawBody) as idempotency key when no eventId", async () => {
    mockFindFirstIntent.mockResolvedValue(FAKE_INTENT);
    mockFindFirstConfig.mockResolvedValue(FAKE_CONFIG);
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockFindUniqueWebhook.mockResolvedValue(null);

    const payload = makePayload(); // no eventId field
    const body = JSON.stringify(payload);
    const expectedKey = crypto.createHash("sha256").update(Buffer.from(body)).digest("hex");

    await post(payload);

    expect(mockFindUniqueWebhook).toHaveBeenCalledWith({
      where: { idempotencyKey: expectedKey },
    });
  });
});
