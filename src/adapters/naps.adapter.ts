/**
 * NAPS (Network of Automated Payment Systems) adapter.
 *
 * This adapter implements the ProviderAdapter interface for the NAPS payment
 * gateway. The NAPS integration uses a redirect-based flow where customers are
 * sent to the NAPS hosted payment page.
 *
 * NOTE: Actual NAPS API endpoint paths, parameter names, and status codes must
 * be updated once real NAPS documentation / integration guide is available.
 * The structure below is a skeleton that mirrors typical NAPS-style integrations.
 */
import crypto from "crypto";
import type { PaymentIntentStatus } from "@/generated/prisma/client";
import { NAPS_STATUS_MAP } from "../lib/status-maps";
import type {
  CancelResult,
  CaptureResult,
  CreateCheckoutParams,
  CreateCheckoutResult,
  CreatePayoutParams,
  NapsCredentials,
  PayoutResult,
  PayoutStatusResult,
  ProviderAdapter,
  QueryStatusResult,
  RefundResult,
  TestConnectionResult,
} from "./types";

// ─── Status mapping is shared: see src/lib/status-maps.ts ─────────────────────────

export class NapsAdapter implements ProviderAdapter {
  readonly name = "NAPS";

  constructor(private readonly credentials: NapsCredentials) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private buildSignature(fields: Record<string, string>): string {
    // NAPS typically signs a concatenated string of specific fields + secret key.
    // Adjust the exact concatenation order per NAPS integration guide.
    const data = [
      fields["MerchantID"] ?? "",
      fields["TerminalID"] ?? "",
      fields["Amount"] ?? "",
      fields["OrderID"] ?? "",
      this.credentials.secretKey,
    ].join("|");
    return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
  }

  private buildUrl(path: string): string {
    const base = this.credentials.baseUrl.replace(/\/$/, "");
    return `${base}${path}`;
  }

  // ─── createCheckoutSession ────────────────────────────────────────────────────

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const amountStr = (params.amount / 100).toFixed(2); // NAPS uses decimal MAD
    const requestFields: Record<string, string> = {
      MerchantID: this.credentials.merchantId,
      TerminalID: this.credentials.terminalId,
      OrderID: params.correlationId,
      Amount: amountStr,
      Currency: params.currency,
      Description: params.description,
      ReturnURL: params.returnUrl,
      WebhookURL: params.webhookUrl,
      CustomerEmail: params.customerEmail ?? "",
      CustomerName: params.customerName ?? "",
    };

    requestFields["Signature"] = this.buildSignature(requestFields);

    // Build redirect URL with query parameters (NAPS redirect flow)
    const qs = new URLSearchParams(requestFields).toString();
    const redirectUrl = `${this.buildUrl("/checkout/start")}?${qs}`;

    // The providerRef is the OrderID; NAPS will echo it back in webhooks.
    return {
      redirectUrl,
      providerRef: params.correlationId,
      rawRequest: requestFields,
      rawResponse: { checkoutUrl: redirectUrl },
    };
  }

  // ─── capturePayment ──────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async capturePayment(
    _providerRef: string,
    _amount: number,
    _currency: string,
  ): Promise<CaptureResult> {
    throw new Error("NAPS does not support pre-authorisation / capture flow");
  }

  // ─── cancelPayment ───────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancelPayment(
    _providerRef: string,
    _amount: number,
    _currency: string,
  ): Promise<CancelResult> {
    throw new Error("NAPS does not support pre-authorisation / void flow");
  }

  // ─── queryTransactionStatus ───────────────────────────────────────────────────

  async queryTransactionStatus(providerRef: string): Promise<QueryStatusResult> {
    const requestFields: Record<string, string> = {
      MerchantID: this.credentials.merchantId,
      TerminalID: this.credentials.terminalId,
      OrderID: providerRef,
    };
    requestFields["Signature"] = this.buildSignature(requestFields);

    const response = await fetch(this.buildUrl("/api/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestFields),
    });

    const raw = (await response.json()) as Record<string, unknown>;
    const providerStatus = (raw["Status"] as string | undefined) ?? "UNKNOWN";

    return {
      status: this.mapStatusToInternal(providerStatus),
      providerTransactionId: raw["TransactionID"] as string | undefined,
      rawResponse: raw,
    };
  }

  // ─── refund ───────────────────────────────────────────────────────────────────

  async refund(providerRef: string, amount: number, currency: string): Promise<RefundResult> {
    const amountStr = (amount / 100).toFixed(2);
    const requestFields: Record<string, string> = {
      MerchantID: this.credentials.merchantId,
      TerminalID: this.credentials.terminalId,
      OriginalOrderID: providerRef,
      Amount: amountStr,
      Currency: currency,
    };
    requestFields["Signature"] = this.buildSignature(requestFields);

    const response = await fetch(this.buildUrl("/api/refund"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestFields),
    });

    const raw = (await response.json()) as Record<string, unknown>;
    const success =
      (raw["Status"] as string | undefined)?.toUpperCase() === "APPROVED" ||
      (raw["ResponseCode"] as string | undefined) === "00";

    return {
      success,
      providerRefundRef: raw["RefundID"] as string | undefined,
      rawRequest: requestFields,
      rawResponse: raw,
    };
  }

  // ─── verifyWebhookSignature ───────────────────────────────────────────────────

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const receivedSig = headers["x-naps-signature"] ?? headers["X-Naps-Signature"] ?? "";
    if (!receivedSig) return false;

    const expectedSig = crypto
      .createHmac("sha256", this.credentials.secretKey)
      .update(rawBody)
      .digest("hex")
      .toUpperCase();

    try {
      return crypto.timingSafeEqual(
        Buffer.from(receivedSig.toUpperCase()),
        Buffer.from(expectedSig),
      );
    } catch {
      return false;
    }
  }

  // ─── mapStatusToInternal ──────────────────────────────────────────────────────

  mapStatusToInternal(providerStatus: string): PaymentIntentStatus {
    return NAPS_STATUS_MAP[providerStatus.toUpperCase()] ?? "PROCESSING";
  }

  // ─── testConnection ───────────────────────────────────────────────────────────

  async createPayout(_params: CreatePayoutParams): Promise<PayoutResult> {
    throw new Error(`${this.name} payouts are not yet implemented`);
  }

  async getPayoutStatus(_providerTransferId: string): Promise<PayoutStatusResult> {
    throw new Error(`${this.name} payout status is not yet implemented`);
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const response = await fetch(this.buildUrl("/api/ping"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          MerchantID: this.credentials.merchantId,
          TerminalID: this.credentials.terminalId,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return { connected: true };

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { connected: false, error: (body["message"] as string) ?? `HTTP ${response.status}` };
    } catch (err: unknown) {
      return { connected: false, error: (err as Error).message };
    }
  }
}
