import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();

vi.mock("../lib/prisma", () => ({
  prisma: {
    paymentIntent: { findUnique: vi.fn() },
    tenant: { findUnique: vi.fn() },
  },
}));

vi.mock("../lib/encryption", () => ({
  decrypt: vi.fn(() => "test-signing-secret"),
}));

vi.mock("../lib/inngest", () => ({
  inngest: { createFunction: vi.fn((_opts: unknown, handler: unknown) => handler) },
}));

import { prisma } from "../lib/prisma";
import { verifyWebhookSignatureHeader } from "../lib/webhook-sign";
import { notifications } from "./notifications.inngest";

const mockFindIntent = prisma.paymentIntent.findUnique as ReturnType<typeof vi.fn>;
const mockFindTenant = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;

const EVENT = {
  data: { intentId: "intent-1", tenantId: "tenant-a", status: "SUCCEEDED", webhookEventId: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", mockFetch);

  mockFindIntent.mockResolvedValue({
    paymentLink: {
      amount: "100.00",
      currency: "MAD",
      reference: "REF-1",
      description: "Test",
      customerEmail: null,
      customerPhone: null,
      customerName: null,
    },
    metadata: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications (outbound merchant webhook)", () => {
  it("signs the outbound webhook when a signing secret is configured", async () => {
    mockFindTenant.mockResolvedValue({
      name: "Tenant A",
      notifyWebhookUrl: "https://example.com/hook",
      webhookSigningSecret: "v2:encrypted",
    });

    await (notifications as Function)({ event: EVENT });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(init.headers["X-CorpoPay-Webhook-Id"]).toBe("intent-1:SUCCEEDED");
    expect(init.headers["X-CorpoPay-Signature"]).toBeDefined();
    expect(init.headers["X-CorpoPay-Timestamp"]).toBeDefined();

    // The signature must verify against the decrypted secret + the exact raw body.
    expect(
      verifyWebhookSignatureHeader(
        "test-signing-secret",
        init.headers["X-CorpoPay-Signature"],
        init.body,
      ),
    ).toBe(true);
  });

  it("sends unsigned when no signing secret is configured", async () => {
    mockFindTenant.mockResolvedValue({
      name: "Tenant A",
      notifyWebhookUrl: "https://example.com/hook",
      webhookSigningSecret: null,
    });

    await (notifications as Function)({ event: EVENT });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-CorpoPay-Webhook-Id"]).toBe("intent-1:SUCCEEDED");
    expect(init.headers["X-CorpoPay-Signature"]).toBeUndefined();
    expect(init.headers["X-CorpoPay-Timestamp"]).toBeUndefined();
  });
});
