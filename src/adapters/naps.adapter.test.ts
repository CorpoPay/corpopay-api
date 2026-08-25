import crypto from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NapsAdapter } from "./naps.adapter";
import type { NapsCredentials } from "./types";

const CREDENTIALS: NapsCredentials = {
  merchantId: "MERCH",
  terminalId: "TERM",
  secretKey: "naps-secret",
  baseUrl: "https://sandbox.naps.example/",
};

function makeAdapter() {
  return new NapsAdapter(CREDENTIALS);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NapsAdapter.createCheckoutSession", () => {
  it("builds a signed redirect URL and echoes the correlationId as providerRef", async () => {
    const adapter = makeAdapter();
    const result = await adapter.createCheckoutSession({
      amount: 12345, // centimes
      currency: "MAD",
      reference: "REF-1",
      description: "Test",
      returnUrl: "https://example.com/return",
      webhookUrl: "https://api.example.com/webhooks/naps",
      correlationId: "corr-1",
    });

    expect(result.providerRef).toBe("corr-1");
    expect(result.redirectUrl).toContain("/checkout/start?");
    expect(result.redirectUrl).toContain("OrderID=corr-1");
    expect(result.redirectUrl).toContain("Amount=123.45");

    const raw = result.rawRequest as Record<string, string>;
    expect(raw["Signature"]).toMatch(/^[0-9A-F]{64}$/);
    expect(raw["MerchantID"]).toBe("MERCH");
  });
});

describe("NapsAdapter.queryTransactionStatus", () => {
  it("maps the provider Status to an internal status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ Status: "APPROVED", TransactionID: "tx-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeAdapter().queryTransactionStatus("corr-1");
    expect(result.status).toBe("SUCCEEDED");
    expect(result.providerTransactionId).toBe("tx-1");
  });

  it("defaults to PROCESSING for unknown statuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({}) }));
    const result = await makeAdapter().queryTransactionStatus("corr-1");
    expect(result.status).toBe("PROCESSING");
  });
});

describe("NapsAdapter.refund", () => {
  it("succeeds when the provider returns APPROVED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ Status: "APPROVED", RefundID: "r-1" }) }),
    );
    const result = await makeAdapter().refund("corr-1", 5000, "MAD");
    expect(result.success).toBe(true);
    expect(result.providerRefundRef).toBe("r-1");
  });

  it("succeeds when ResponseCode is 00", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ ResponseCode: "00", RefundID: "r-2" }) }),
    );
    const result = await makeAdapter().refund("corr-1", 5000, "MAD");
    expect(result.success).toBe(true);
  });

  it("fails on a DECLINED status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ Status: "DECLINED" }) }),
    );
    const result = await makeAdapter().refund("corr-1", 5000, "MAD");
    expect(result.success).toBe(false);
  });
});

describe("NapsAdapter.verifyWebhookSignature", () => {
  it("accepts a valid HMAC-SHA256 signature", () => {
    const rawBody = Buffer.from("hello");
    const sig = crypto
      .createHmac("sha256", CREDENTIALS.secretKey)
      .update(rawBody)
      .digest("hex")
      .toUpperCase();
    expect(makeAdapter().verifyWebhookSignature(rawBody, { "x-naps-signature": sig })).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(makeAdapter().verifyWebhookSignature(Buffer.from("x"), {})).toBe(false);
  });

  it("rejects an invalid signature", () => {
    expect(
      makeAdapter().verifyWebhookSignature(Buffer.from("x"), { "x-naps-signature": "BAD" }),
    ).toBe(false);
  });
});

describe("NapsAdapter pre-auth operations", () => {
  it("throws for capturePayment (not supported)", async () => {
    await expect(makeAdapter().capturePayment("r", 1, "MAD")).rejects.toThrow(
      "does not support pre-authorisation",
    );
  });

  it("throws for cancelPayment (not supported)", async () => {
    await expect(makeAdapter().cancelPayment("r", 1, "MAD")).rejects.toThrow(
      "does not support pre-authorisation",
    );
  });
});

describe("NapsAdapter.testConnection", () => {
  it("reports connected when /api/ping returns ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    expect(await makeAdapter().testConnection()).toEqual({ connected: true });
  });

  it("reports disconnected on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "boom" }),
      }),
    );
    const result = await makeAdapter().testConnection();
    expect(result.connected).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("reports disconnected on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await makeAdapter().testConnection();
    expect(result.connected).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
