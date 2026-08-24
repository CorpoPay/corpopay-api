import { describe, it, expect } from "vitest";
import { FakeAdapter } from "./fake.adapter";

describe("FakeAdapter", () => {
  it("implements the ProviderAdapter interface with deterministic defaults", async () => {
    const adapter = new FakeAdapter();

    expect(adapter.name).toBe("FAKE");
    expect(await adapter.testConnection()).toEqual({ connected: true });
    expect(adapter.verifyWebhookSignature()).toBe(true);

    const checkout = await adapter.createCheckoutSession({
      amount: 1000,
      currency: "MAD",
      reference: "ref",
      description: "test",
      returnUrl: "https://example.com",
      webhookUrl: "https://example.com/webhook",
      correlationId: "corr-1",
    });
    expect(checkout.providerRef).toBe("corr-1");

    const status = await adapter.queryTransactionStatus("corr-1");
    expect(status.status).toBe("SUCCEEDED");
  });

  it("honors configured overrides", async () => {
    const adapter = new FakeAdapter({ status: "FAILED", signatureValid: false });

    expect(adapter.verifyWebhookSignature()).toBe(false);
    expect((await adapter.queryTransactionStatus("x")).status).toBe("FAILED");
  });
});
