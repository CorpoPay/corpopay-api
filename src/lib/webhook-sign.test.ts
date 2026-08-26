import { describe, expect, it } from "vitest";
import {
  buildWebhookSignatureHeader,
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignatureHeader,
} from "./webhook-sign";

describe("webhook-sign (outbound merchant webhooks)", () => {
  it("generates a 64-char hex secret, unique per call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("signs deterministically for identical inputs", () => {
    const sig = signWebhookPayload("secret", 1234, '{"a":1}');
    expect(sig).toBe(signWebhookPayload("secret", 1234, '{"a":1}'));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the signature when body, secret, or timestamp change", () => {
    const base = signWebhookPayload("secret", 1234, '{"a":1}');
    expect(signWebhookPayload("secret", 1234, '{"a":2}')).not.toBe(base);
    expect(signWebhookPayload("other", 1234, '{"a":1}')).not.toBe(base);
    expect(signWebhookPayload("secret", 1235, '{"a":1}')).not.toBe(base);
  });

  it("round-trips build → verify", () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ event: "payment.updated", status: "SUCCEEDED" });
    const { signature } = buildWebhookSignatureHeader(secret, body);
    expect(verifyWebhookSignatureHeader(secret, signature, body)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const secret = generateWebhookSecret();
    const { signature } = buildWebhookSignatureHeader(secret, '{"a":1}');
    expect(verifyWebhookSignatureHeader(secret, signature, '{"a":2}')).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const secret = generateWebhookSecret();
    const { signature } = buildWebhookSignatureHeader(secret, '{"a":1}');
    expect(verifyWebhookSignatureHeader(generateWebhookSecret(), signature, '{"a":1}')).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyWebhookSignatureHeader("secret", "garbage", "{}")).toBe(false);
    expect(verifyWebhookSignatureHeader("secret", "t=1234", "{}")).toBe(false);
    expect(verifyWebhookSignatureHeader("secret", "v1=abcd", "{}")).toBe(false);
  });
});
