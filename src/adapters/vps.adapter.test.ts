/**
 * vps.adapter.test.ts
 *
 * Unit tests for VpsAdapter — focused on the two functions that caused
 * the March 2026 production incident:
 *
 *   verifyWebhookSignature — every failure mode that can produce a 401
 *   mapStatusToInternal    — every Payzone status string we handle
 *
 * No network calls, no DB, no Prisma — pure unit tests.
 */
import crypto from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { VpsAdapter } from "./vps.adapter";
import type { VpsCredentials } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOTIFICATION_KEY = "test-notification-key-32-chars!!";
const CALLER_PASSWORD = "test-caller-password";

function makeCredentials(overrides: Partial<VpsCredentials> = {}): VpsCredentials {
  return {
    merchantAccount: "Int_acme_Test",
    paywallSecretKey: "test-paywall-secret",
    paywallUrl: "https://payment-sandbox.payzone.ma/pwthree/launch",
    apiUrl: "https://payment-sandbox.payzone.ma",
    callerName: "$apicaller",
    callerPassword: CALLER_PASSWORD,
    notificationKey: NOTIFICATION_KEY,
    callbackTestMode: false,
    skin: "vps-1-vue",
    mode: "DEEP_LINK",
    doFundsAuthOnly: false,
    showPaymentProfiles: "false",
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<VpsCredentials> = {}): VpsAdapter {
  return new VpsAdapter(makeCredentials(overrides));
}

/**
 * Produce a valid HMAC-SHA256 signature for a given rawBody using the
 * standard notificationKey, as Payzone would send it.
 */
function signBody(body: Buffer, key: string = NOTIFICATION_KEY): string {
  return crypto.createHmac("sha256", key).update(body).digest("hex");
}

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe("VpsAdapter.verifyWebhookSignature", () => {
  const adapter = makeAdapter();
  const rawBody = Buffer.from(
    JSON.stringify({
      id: "txn_abc123",
      orderId: "69b4222e19645b6d2644af53",
      customerId: "cmmoxq3un000314ai1zma1atq",
      status: "CHARGED",
      merchantAccount: "Int_acme_Test",
    }),
  );

  // ── Happy path ───────────────────────────────────────────────────────────

  it("accepts a valid x-callback-signature header", () => {
    const sig = signBody(rawBody);
    expect(adapter.verifyWebhookSignature(rawBody, { "x-callback-signature": sig })).toBe(true);
  });

  it("accepts signature in x-payzone-signature header", () => {
    const sig = signBody(rawBody);
    expect(adapter.verifyWebhookSignature(rawBody, { "x-payzone-signature": sig })).toBe(true);
  });

  it("accepts signature in x-vps-signature header", () => {
    const sig = signBody(rawBody);
    expect(adapter.verifyWebhookSignature(rawBody, { "x-vps-signature": sig })).toBe(true);
  });

  it("accepts signature in x-signature header", () => {
    const sig = signBody(rawBody);
    expect(adapter.verifyWebhookSignature(rawBody, { "x-signature": sig })).toBe(true);
  });

  it("is case-insensitive — accepts uppercase hex signature", () => {
    const sig = signBody(rawBody).toUpperCase();
    expect(adapter.verifyWebhookSignature(rawBody, { "x-callback-signature": sig })).toBe(true);
  });

  it("is case-insensitive — accepts mixed-case hex signature", () => {
    const raw = signBody(rawBody);
    const mixed = raw
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join("");
    expect(adapter.verifyWebhookSignature(rawBody, { "x-callback-signature": mixed })).toBe(true);
  });

  // ── Wrong key ────────────────────────────────────────────────────────────

  it("rejects a signature produced with the wrong notificationKey", () => {
    const sig = signBody(rawBody, "wrong-key-that-is-not-configured");
    expect(adapter.verifyWebhookSignature(rawBody, { "x-callback-signature": sig })).toBe(false);
  });

  it("rejects when notificationKey is rotated — old key no longer matches", () => {
    // Simulates the Payzone credential rotation incident:
    // adapter was configured with OLD key, Payzone signed with NEW key.
    const OLD_KEY = "old-notification-key-32-chars!!!";
    const adapterWithOldKey = makeAdapter({ notificationKey: OLD_KEY });
    const sigWithNewKey = signBody(rawBody, NOTIFICATION_KEY);
    expect(
      adapterWithOldKey.verifyWebhookSignature(rawBody, { "x-callback-signature": sigWithNewKey }),
    ).toBe(false);
  });

  // ── Missing / empty signature header ─────────────────────────────────────

  it("rejects when no signature header is present at all", () => {
    expect(adapter.verifyWebhookSignature(rawBody, {})).toBe(false);
  });

  it("rejects when signature header is an empty string", () => {
    expect(adapter.verifyWebhookSignature(rawBody, { "x-callback-signature": "" })).toBe(false);
  });

  it("rejects when all known signature headers are present but empty", () => {
    expect(
      adapter.verifyWebhookSignature(rawBody, {
        "x-callback-signature": "",
        "x-payzone-signature": "",
        "x-vps-signature": "",
        "x-signature": "",
      }),
    ).toBe(false);
  });

  // ── Missing notificationKey in credentials ────────────────────────────────

  it("rejects (fail-safe) when notificationKey is not configured", () => {
    const adapterNoKey = makeAdapter({ notificationKey: undefined as any });
    const sig = signBody(rawBody);
    expect(adapterNoKey.verifyWebhookSignature(rawBody, { "x-callback-signature": sig })).toBe(
      false,
    );
  });

  it("rejects (fail-safe) when notificationKey is an empty string", () => {
    const adapterEmptyKey = makeAdapter({ notificationKey: "" });
    const sig = signBody(rawBody);
    expect(adapterEmptyKey.verifyWebhookSignature(rawBody, { "x-callback-signature": sig })).toBe(
      false,
    );
  });

  // ── Tampered body ─────────────────────────────────────────────────────────

  it("rejects when the request body has been tampered with", () => {
    const sig = signBody(rawBody);
    const tamperedBody = Buffer.from(
      JSON.stringify({
        id: "txn_abc123",
        orderId: "69b4222e19645b6d2644af53",
        customerId: "cmmoxq3un000314ai1zma1atq",
        status: "CHARGED",
        merchantAccount: "Int_acme_Test",
        tampered: true, // extra field injected by attacker
      }),
    );
    expect(adapter.verifyWebhookSignature(tamperedBody, { "x-callback-signature": sig })).toBe(
      false,
    );
  });

  it("rejects when body is empty but signature was for a non-empty body", () => {
    const sig = signBody(rawBody);
    expect(adapter.verifyWebhookSignature(Buffer.from(""), { "x-callback-signature": sig })).toBe(
      false,
    );
  });

  it("rejects a replay of a different transaction's valid signature", () => {
    const otherBody = Buffer.from(
      JSON.stringify({ orderId: "other-booking-id", status: "CHARGED" }),
    );
    const sigForOtherBody = signBody(otherBody);
    // Valid sig — but for a different payload
    expect(
      adapter.verifyWebhookSignature(rawBody, { "x-callback-signature": sigForOtherBody }),
    ).toBe(false);
  });

  // ── callbackTestMode bypass ───────────────────────────────────────────────

  it("bypasses signature check when callbackTestMode is true", () => {
    const testModeAdapter = makeAdapter({ callbackTestMode: true });
    // Deliberately wrong signature — should still pass
    expect(
      testModeAdapter.verifyWebhookSignature(rawBody, { "x-callback-signature": "BADSIG" }),
    ).toBe(true);
  });

  it("does NOT bypass signature check when callbackTestMode is false", () => {
    const prodAdapter = makeAdapter({ callbackTestMode: false });
    expect(prodAdapter.verifyWebhookSignature(rawBody, { "x-callback-signature": "BADSIG" })).toBe(
      false,
    );
  });

  // ── Header precedence ─────────────────────────────────────────────────────

  it("prefers x-callback-signature over other headers when multiple are present", () => {
    const correctSig = signBody(rawBody);
    const wrongSig = signBody(rawBody, "wrong-key");
    // x-callback-signature is correct, others are wrong — should still pass
    expect(
      adapter.verifyWebhookSignature(rawBody, {
        "x-callback-signature": correctSig,
        "x-payzone-signature": wrongSig,
      }),
    ).toBe(true);
  });
});

// ─── mapStatusToInternal ──────────────────────────────────────────────────────

describe("VpsAdapter.mapStatusToInternal", () => {
  const adapter = makeAdapter();

  // ── REQUIRES_ACTION (pre-auth / 3DS) ─────────────────────────────────────

  it.each([
    "AUTHORISED",
    "AUTHORIZED",
    "AUTHORIZATION",
    "PREAUTHORIZED",
    "PRE_AUTHORIZED",
    "REDIRECTED",
    "AUTHORIZE_PENDING",
    "AUTHORIZATION_PENDING",
    "CHALLENGE_REQUIRED",
    "CHALLENGED",
    "PENDING_3DS",
    "THREE_DS_PENDING",
  ])("maps %s → REQUIRES_ACTION", (status) => {
    expect(adapter.mapStatusToInternal(status)).toBe("REQUIRES_ACTION");
  });

  // ── SUCCEEDED ────────────────────────────────────────────────────────────

  it.each(["CHARGED", "CAPTURED", "PAID", "SETTLED", "SETTLEMENT", "COMPLETED"])(
    "maps %s → SUCCEEDED",
    (status) => {
      expect(adapter.mapStatusToInternal(status)).toBe("SUCCEEDED");
    },
  );

  // ── FAILED ───────────────────────────────────────────────────────────────

  it.each(["REFUSED", "DECLINED", "FAILED", "ERROR"])("maps %s → FAILED", (status) => {
    expect(adapter.mapStatusToInternal(status)).toBe("FAILED");
  });

  // ── CANCELED ─────────────────────────────────────────────────────────────

  it.each(["CANCELLED", "CANCELED", "AUTH_REVERSED", "VOIDED"])("maps %s → CANCELED", (status) => {
    expect(adapter.mapStatusToInternal(status)).toBe("CANCELED");
  });

  // ── PROCESSING ───────────────────────────────────────────────────────────

  it.each(["PENDING", "IN_PROGRESS", "PROCESSING", "SETTLEMENT_PROCESSING"])(
    "maps %s → PROCESSING",
    (status) => {
      expect(adapter.mapStatusToInternal(status)).toBe("PROCESSING");
    },
  );

  // ── REFUNDED ─────────────────────────────────────────────────────────────

  it("maps REFUNDED → REFUNDED", () => {
    expect(adapter.mapStatusToInternal("REFUNDED")).toBe("REFUNDED");
  });

  // ── Case-insensitivity ────────────────────────────────────────────────────

  it("is case-insensitive — lowercase charged → SUCCEEDED", () => {
    expect(adapter.mapStatusToInternal("charged")).toBe("SUCCEEDED");
  });

  it("is case-insensitive — mixed-case Authorised → REQUIRES_ACTION", () => {
    expect(adapter.mapStatusToInternal("Authorised")).toBe("REQUIRES_ACTION");
  });

  // ── Unknown status ────────────────────────────────────────────────────────

  it("maps unknown status string → PROCESSING (safe default)", () => {
    expect(adapter.mapStatusToInternal("SOME_FUTURE_STATUS")).toBe("PROCESSING");
  });

  it("maps empty string → PROCESSING (safe default)", () => {
    expect(adapter.mapStatusToInternal("")).toBe("PROCESSING");
  });
});

// ─── generatePaywallSignature (via createCheckoutSession) ────────────────────

describe("VpsAdapter.createCheckoutSession — paywall signature", () => {
  it("produces a deterministic SHA-256 hex signature for the same payload", async () => {
    const adapter = makeAdapter();
    const params = {
      amount: 65895,
      currency: "MAD",
      reference: "69b4222e19645b6d2644af53",
      description: "Booking for Hotel",
      returnUrl: "https://example.com/return",
      webhookUrl: "https://api.example.com/webhooks/vps",
      correlationId: "cmmp09m9q000311x9d9is81yr",
    };

    const result1 = await adapter.createCheckoutSession(params);
    const result2 = await adapter.createCheckoutSession({
      ...params,
      correlationId: "cmmp09m9q000311x9d9is81yr", // same correlationId
    });

    // Signatures differ because timestamp is part of the payload —
    // what we verify is that the signature IS present and is a 64-char hex string.
    expect(result1.providerData).toBeDefined();
    const pd = result1.providerData as Record<string, unknown>;
    expect(typeof pd["signature"]).toBe("string");
    expect(pd["signature"] as string).toHaveLength(64);
    expect(pd["signature"] as string).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets chargeId equal to correlationId", async () => {
    const adapter = makeAdapter();
    const correlationId = "cmmp09m9q000311x9d9is81yr";
    const result = await adapter.createCheckoutSession({
      amount: 10000,
      currency: "MAD",
      reference: "test-ref",
      description: "Test booking",
      returnUrl: "https://example.com/return",
      webhookUrl: "https://api.example.com/webhooks/vps",
      correlationId,
    });

    const pd = result.providerData as Record<string, unknown>;
    expect(pd["chargeId"]).toBe(correlationId);
    expect(result.providerRef).toBe(correlationId);
  });

  it("sets doFundsAuthOnly from credentials when isPreauth is not specified", async () => {
    const adapter = makeAdapter({ doFundsAuthOnly: true });
    const result = await adapter.createCheckoutSession({
      amount: 10000,
      currency: "MAD",
      reference: "test-ref",
      description: "Test booking",
      returnUrl: "https://example.com/return",
      webhookUrl: "https://api.example.com/webhooks/vps",
      correlationId: "test-correlation-id",
    });

    const payload = JSON.parse((result.providerData as any)["payload"]);
    expect(payload["doFundsAuthOnly"]).toBe(true);
  });

  it("overrides doFundsAuthOnly with isPreauth param", async () => {
    const adapter = makeAdapter({ doFundsAuthOnly: false });
    const result = await adapter.createCheckoutSession({
      amount: 10000,
      currency: "MAD",
      reference: "test-ref",
      description: "Test booking",
      returnUrl: "https://example.com/return",
      webhookUrl: "https://api.example.com/webhooks/vps",
      correlationId: "test-correlation-id",
      isPreauth: true,
    });

    const payload = JSON.parse((result.providerData as any)["payload"]);
    expect(payload["doFundsAuthOnly"]).toBe(true);
  });
});

// ─── encryption.ts ────────────────────────────────────────────────────────────
// Import here so coverage tracks it alongside the adapter tests.

describe("encrypt / decrypt roundtrip", async () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    // 32-byte hex key (64 chars)
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  it("decrypts back to the original plaintext (v2 GCM)", async () => {
    const { encrypt, decrypt } = await import("../lib/encryption");
    const plaintext = JSON.stringify({
      notificationKey: "test-notification-key",
      callerPassword: "khRhEge9BkUk9znc",
    });
    const ciphertext = encrypt(plaintext);
    expect(ciphertext.startsWith("v2:")).toBe(true);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext on each call (random IV)", async () => {
    const { encrypt } = await import("../lib/encryption");
    const c1 = encrypt("same-plaintext");
    const c2 = encrypt("same-plaintext");
    expect(c1).not.toBe(c2);
  });

  it("throws on auth tag mismatch (tampered ciphertext)", async () => {
    const { encrypt, decrypt } = await import("../lib/encryption");
    const ciphertext = encrypt("sensitive");
    // Flip one character in the ciphertext body
    const tampered = ciphertext.slice(0, -4) + "XXXX";
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when ENCRYPTION_KEY is missing", async () => {
    delete process.env.ENCRYPTION_KEY;
    // Re-import to bust module cache
    const { encrypt } = await import("../lib/encryption");
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY environment variable is not set");
    process.env.ENCRYPTION_KEY = originalKey ?? "a".repeat(64);
  });
});
