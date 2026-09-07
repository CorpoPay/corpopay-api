import type { PaymentIntentStatus } from "@/generated/prisma/client";
import type {
  CancelResult,
  CaptureResult,
  CreateCheckoutParams,
  CreateCheckoutResult,
  CreatePayoutParams,
  DisputeSummary,
  ListDisputesResult,
  PayoutResult,
  PayoutStatusResult,
  ProviderAdapter,
  QueryStatusResult,
  RefundResult,
  SubmitDisputeEvidenceParams,
  SubmitDisputeEvidenceResult,
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

  async createPayout(params: CreatePayoutParams): Promise<PayoutResult> {
    return {
      success: true,
      providerTransferId: `fake-payout-${params.reference}`,
      rawRequest: {},
      rawResponse: {},
    };
  }

  async getPayoutStatus(providerTransferId: string): Promise<PayoutStatusResult> {
    return { status: "PAID", providerTransferId, rawResponse: {} };
  }

  async listDisputes(): Promise<ListDisputesResult> {
    // Deterministic: no disputes by default. Tests can override via opts if needed.
    const disputes: DisputeSummary[] = [];
    return { disputes, rawResponse: {} };
  }

  async submitDisputeEvidence(
    params: SubmitDisputeEvidenceParams,
  ): Promise<SubmitDisputeEvidenceResult> {
    return {
      success: true,
      rawRequest: { providerDisputeId: params.providerDisputeId, evidence: params.evidence },
      rawResponse: {},
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { connected: true };
  }
}
