import { beforeEach, describe, expect, it, vi } from "vitest";
import { StripeAdapter } from "./stripe.adapter";
import type { StripeCredentials } from "./types";

const { mockStripe } = vi.hoisted(() => {
  const instance = {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
    paymentIntents: { create: vi.fn(), capture: vi.fn(), cancel: vi.fn(), retrieve: vi.fn() },
    refunds: { create: vi.fn() },
    balance: { retrieve: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  };
  return { mockStripe: instance };
});

vi.mock("stripe", () => ({
  // biome-ignore lint/complexity/useArrowFunction: must stay constructible for `new Stripe()`
  default: vi.fn(function () {
    return mockStripe;
  }),
}));

const CREDENTIALS: StripeCredentials = {
  secretKey: "demo-stripe-secret-key",
  webhookSecret: "demo-stripe-webhook-secret",
  publishableKey: "demo-stripe-publishable-key",
};

function makeAdapter() {
  return new StripeAdapter(CREDENTIALS);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const baseParams = {
  amount: 1000,
  currency: "MAD",
  description: "Test",
  reference: "REF-1",
  returnUrl: "https://example.com/return",
  webhookUrl: "https://api.example.com/webhooks/stripe",
  correlationId: "corr-1",
};

describe("StripeAdapter.createCheckoutSession", () => {
  it("creates a hosted Checkout Session and returns its URL + PaymentIntent id", async () => {
    mockStripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_123",
      payment_intent: "pi_123",
      id: "cs_123",
    });

    const result = await makeAdapter().createCheckoutSession(baseParams);

    expect(result.redirectUrl).toBe("https://checkout.stripe.com/pay/cs_123");
    expect(result.providerRef).toBe("pi_123");
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledOnce();
  });

  it("returns a clientSecret for wallet (apple_pay / google_pay) mode", async () => {
    mockStripe.paymentIntents.create.mockResolvedValue({
      id: "pi_456",
      client_secret: "pi_456_secret_abc", // #gitleaks:allow (test fixture)
    });

    const result = await makeAdapter().createCheckoutSession({
      ...baseParams,
      walletMode: "apple_pay",
    });

    expect(result.redirectUrl).toBe("");
    expect(result.stripeData?.clientSecret).toBe("pi_456_secret_abc");
    expect(result.providerRef).toBe("pi_456");
  });
});

describe("StripeAdapter.capturePayment / cancelPayment / refund", () => {
  it("captures a pre-authorised PaymentIntent", async () => {
    mockStripe.paymentIntents.capture.mockResolvedValue({ status: "succeeded" });
    const result = await makeAdapter().capturePayment("pi_1", 1000, "MAD");
    expect(result.success).toBe(true);
  });

  it("cancels a PaymentIntent", async () => {
    mockStripe.paymentIntents.cancel.mockResolvedValue({ status: "canceled" });
    const result = await makeAdapter().cancelPayment("pi_1", 1000, "MAD");
    expect(result.success).toBe(true);
  });

  it("refunds a PaymentIntent and reports success on succeeded/pending", async () => {
    mockStripe.refunds.create.mockResolvedValue({ status: "succeeded", id: "re_1" });
    const result = await makeAdapter().refund("pi_1", 1000, "MAD");
    expect(result.success).toBe(true);
    expect(result.providerRefundRef).toBe("re_1");
  });
});

describe("StripeAdapter.queryTransactionStatus", () => {
  it("retrieves a PaymentIntent by id (pi_…)", async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      status: "succeeded",
      latest_charge: "ch_1",
    });
    const result = await makeAdapter().queryTransactionStatus("pi_123");
    expect(result.status).toBe("SUCCEEDED");
    expect(result.providerTransactionId).toBe("ch_1");
  });

  it("retrieves a Checkout Session by id (cs_…)", async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      payment_status: "paid",
      payment_intent: { status: "succeeded", latest_charge: "ch_2" },
    });
    const result = await makeAdapter().queryTransactionStatus("cs_123");
    expect(result.status).toBe("SUCCEEDED");
    expect(result.providerTransactionId).toBe("ch_2");
  });
});

describe("StripeAdapter.verifyWebhookSignature", () => {
  it("returns true when constructEvent succeeds", () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({ type: "payment_intent.succeeded" });
    expect(
      makeAdapter().verifyWebhookSignature(Buffer.from("{}"), { "stripe-signature": "sig" }),
    ).toBe(true);
  });

  it("returns false when constructEvent throws", () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    expect(
      makeAdapter().verifyWebhookSignature(Buffer.from("{}"), { "stripe-signature": "sig" }),
    ).toBe(false);
  });

  it("returns false when the signature header or secret is missing", () => {
    expect(makeAdapter().verifyWebhookSignature(Buffer.from("{}"), {})).toBe(false);
  });
});

describe("StripeAdapter.mapStatusToInternal", () => {
  it.each([
    ["succeeded", "SUCCEEDED"],
    ["requires_action", "REQUIRES_ACTION"],
    ["processing", "PROCESSING"],
    ["canceled", "CANCELED"],
  ])("maps %s → %s", (stripe, internal) => {
    expect(makeAdapter().mapStatusToInternal(stripe)).toBe(internal);
  });
});

describe("StripeAdapter.testConnection", () => {
  it("reports connected when balance.retrieve succeeds", async () => {
    mockStripe.balance.retrieve.mockResolvedValue({});
    expect(await makeAdapter().testConnection()).toEqual({ connected: true });
  });

  it("reports disconnected when balance.retrieve throws", async () => {
    mockStripe.balance.retrieve.mockRejectedValue(new Error("Invalid API Key"));
    const result = await makeAdapter().testConnection();
    expect(result.connected).toBe(false);
    expect(result.error).toContain("Invalid API Key");
  });
});
