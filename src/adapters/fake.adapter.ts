import type { PaymentIntentStatus } from "@/generated/prisma/client";
import type {
  CancelResult,
  CaptureResult,
  CreateCheckoutParams,
  CreateCheckoutResult,
  ProviderAdapter,
  QueryStatusResult,
  RefundResult,
  TestConnectionResult,
} from "./types";

/**
 * Deterministic in-memory ProviderAdapter for tests.
 * Use it when a test needs a provider without touching a real PSP or mocking fetch.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly name = "FAKE";

  constructor(
    private readonly opts: {
      /** Status returned by queryTransactionStatus. Defaults to SUCCEEDED. */
      status?: PaymentIntentStatus;
      /** Result returned by verifyWebhookSignature. Defaults to true. */
      signatureValid?: boolean;
    } = {},
  ) {}

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    return {
      redirectUrl: "https://fake.example/checkout",
      providerRef: params.correlationId,
      rawRequest: {},
      rawResponse: {},
    };
  }

  async capturePayment(): Promise<CaptureResult> {
    return { success: true, rawResponse: {} };
  }

  async cancelPayment(): Promise<CancelResult> {
    return { success: true, rawResponse: {} };
  }

  async queryTransactionStatus(providerRef: string): Promise<QueryStatusResult> {
    return {
      status: this.opts.status ?? "SUCCEEDED",
      providerTransactionId: `fake-tx-${providerRef}`,
      rawResponse: {},
    };
  }

  async refund(providerRef: string): Promise<RefundResult> {
    return {
      success: true,
      providerRefundRef: `fake-refund-${providerRef}`,
      rawRequest: {},
      rawResponse: {},
    };
  }

  verifyWebhookSignature(): boolean {
    return this.opts.signatureValid ?? true;
  }

  mapStatusToInternal(providerStatus: string): PaymentIntentStatus {
    return (providerStatus as PaymentIntentStatus) ?? "PROCESSING";
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { connected: true };
  }
}
