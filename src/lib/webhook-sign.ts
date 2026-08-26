/**
 * Outbound merchant webhook signing.
 *
 * This is the CorpoPay → merchant direction (the opposite of `webhook-verify.ts`,
 * which verifies provider → CorpoPay inbound webhooks). It signs each
 * `payment.updated` payload so the merchant can prove it came from CorpoPay and
 * was not tampered with in transit.
 *
 * Header scheme (Stripe-like, so merchant integrations feel familiar):
 *
 *   X-CorpoPay-Signature: t=<unix-seconds>,v1=<hex hmac>
 *   X-CorpoPay-Timestamp: <unix-seconds>
 *   X-CorpoPay-Webhook-Id: <stable idempotency key>
 *
 * where `v1 = HMAC-SHA256(secret, "<t>.<body>")`, hex-encoded. The merchant
 * recomputes the HMAC over the exact raw body bytes and compares in constant
 * time. Replay protection (rejecting old `t`) is the merchant's responsibility.
 */
import crypto from "crypto";

const SECRET_BYTES = 32;

/** Generate a new per-tenant webhook signing secret (hex). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(SECRET_BYTES).toString("hex");
}

/** Compute the HMAC-SHA256 hex signature over `<timestamp>.<body>`. */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Build the `X-CorpoPay-Signature` header value plus its timestamp. */
export function buildWebhookSignatureHeader(
  secret: string,
  body: string,
): { signature: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    signature: `t=${timestamp},v1=${signWebhookPayload(secret, timestamp, body)}`,
    timestamp,
  };
}

/**
 * Verify an `X-CorpoPay-Signature` header against a raw body. Constant-time.
 * Returns false on a malformed header, a mismatched signature, or a wrong key.
 *
 * Note: this does NOT enforce a timestamp freshness window (that is the
 * merchant's replay-protection concern); it only proves authenticity.
 */
export function verifyWebhookSignatureHeader(
  secret: string,
  header: string,
  body: string,
): boolean {
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([a-f0-9]+)/i.exec(header)?.[1];
  if (!t || !v1) return false;

  const expected = signWebhookPayload(secret, Number.parseInt(t, 10), body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
