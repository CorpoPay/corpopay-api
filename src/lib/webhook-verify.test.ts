import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./prisma", () => ({
  prisma: {
    paymentIntent: { findFirst: vi.fn() },
    providerConfig: { findFirst: vi.fn() },
  },
}));

vi.mock("../adapters/registry", () => ({
  getAdapter: vi.fn(() => ({ verifyWebhookSignature: vi.fn().mockReturnValue(true) })),
}));

import { Provider } from "@/generated/prisma/client";
import { getAdapter } from "../adapters/registry";
import { prisma } from "./prisma";
import { verifyWebhook } from "./webhook-verify";

const mockFindIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;

const FAKE_INTENT = { tenantId: "tenant-a", correlationId: "corr-1" };
const FAKE_CONFIG = { encryptedCredentials: "v2:{}" };

beforeEach(() => {
  vi.clearAllMocks();
  (getAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
  });
  mockFindConfig.mockResolvedValue(FAKE_CONFIG);
});

describe("verifyWebhook", () => {
  it("rejects malformed JSON", async () => {
    const result = await verifyWebhook(Provider.VPS, Buffer.from("not-json{{"), {});
    expect(result).toMatchObject({ ok: false, failReason: "invalid_json" });
  });

  describe("Stripe", () => {
    const stripeBody = (metadata: Record<string, string>) =>
      Buffer.from(
        JSON.stringify({ type: "payment_intent.succeeded", data: { object: { metadata } } }),
      );

    it("rejects when no correlationId is present in metadata", async () => {
      const result = await verifyWebhook(Provider.STRIPE, stripeBody({}), {});
      expect(result).toMatchObject({ ok: false, failReason: "no_correlation_id" });
    });

    it("rejects when the correlationId does not match an intent", async () => {
      mockFindIntent.mockResolvedValue(null);
      const result = await verifyWebhook(
        Provider.STRIPE,
        stripeBody({ correlationId: "ghost" }),
        {},
      );
      expect(result).toMatchObject({ ok: false, failReason: "intent_not_found" });
    });

    it("accepts a valid signature and returns the tenant", async () => {
      mockFindIntent.mockResolvedValue(FAKE_INTENT);
      const result = await verifyWebhook(
        Provider.STRIPE,
        stripeBody({ correlationId: "corr-1" }),
        {},
      );
      expect(result).toMatchObject({ ok: true, tenantId: "tenant-a" });
    });
  });

  describe("VPS / NAPS", () => {
    const vpsBody = (payload: Record<string, unknown>) => Buffer.from(JSON.stringify(payload));

    it("rejects when the payload has no chargeId/customerId/orderId", async () => {
      const result = await verifyWebhook(Provider.VPS, vpsBody({ status: "CHARGED" }), {});
      expect(result).toMatchObject({ ok: false, failReason: "no_charge_id" });
    });

    it("rejects when no intent matches (correlationId and metadata.reference both miss)", async () => {
      mockFindIntent.mockResolvedValue(null);
      const result = await verifyWebhook(Provider.VPS, vpsBody({ customerId: "ghost" }), {});
      expect(result).toMatchObject({ ok: false, failReason: "intent_not_found" });
    });

    it("falls back to metadata.reference when correlationId lookup misses", async () => {
      mockFindIntent.mockResolvedValueOnce(null).mockResolvedValueOnce(FAKE_INTENT);
      const result = await verifyWebhook(Provider.VPS, vpsBody({ orderId: "booking-ref-123" }), {});
      expect(result).toMatchObject({ ok: true, tenantId: "tenant-a" });
      expect(mockFindIntent).toHaveBeenCalledTimes(2);
    });

    it("rejects when the provider config is missing", async () => {
      mockFindIntent.mockResolvedValue(FAKE_INTENT);
      mockFindConfig.mockResolvedValue(null);
      const result = await verifyWebhook(Provider.VPS, vpsBody({ customerId: "corr-1" }), {});
      expect(result).toMatchObject({ ok: false, failReason: "provider_config_not_found" });
    });

    it("rejects when the adapter reports a signature mismatch", async () => {
      mockFindIntent.mockResolvedValue(FAKE_INTENT);
      (getAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
        verifyWebhookSignature: vi.fn().mockReturnValue(false),
      });
      const result = await verifyWebhook(Provider.VPS, vpsBody({ customerId: "corr-1" }), {});
      expect(result).toMatchObject({ ok: false, failReason: "signature_mismatch" });
    });

    it("accepts a valid signature", async () => {
      mockFindIntent.mockResolvedValue(FAKE_INTENT);
      const result = await verifyWebhook(Provider.VPS, vpsBody({ customerId: "corr-1" }), {});
      expect(result).toMatchObject({ ok: true, tenantId: "tenant-a" });
    });
  });

  it("surfaces exceptions as failReason 'exception'", async () => {
    mockFindIntent.mockRejectedValue(new Error("db down"));
    const result = await verifyWebhook(
      Provider.VPS,
      Buffer.from(JSON.stringify({ customerId: "corr-1" })),
      {},
    );
    expect(result).toMatchObject({ ok: false, failReason: "exception" });
  });
});
