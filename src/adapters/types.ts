import { PaymentIntentStatus } from '@prisma/client';

// ─── Credential shapes ───────────────────────────────────────────────────────────

export interface NapsCredentials {
  merchantId: string;
  terminalId: string;
  secretKey: string;
  baseUrl: string;
}

/**
 * VPS / Payzone credential shape.
 *
 * Stored AES-256 encrypted in ProviderConfig.encryptedCredentials.
 * Combines both the paywall redirect credentials and the server-to-server
 * command API credentials (capture / cancel / refund).
 */
export interface VpsCredentials {
  // ── Paywall (front-end redirect) ──────────────────────────────
  /** Payzone merchant account identifier */
  merchantAccount: string;
  /** Secret key used to SHA-256 sign the paywall redirect payload */
  paywallSecretKey: string;
  /** Payzone hosted paywall base URL */
  paywallUrl: string;
  /** UI skin key for the Payzone hosted paywall (e.g. 'vps-1-vue') */
  skin?: string;
  /** When true the paywall performs pre-authorisation only (doFundsAuthOnly) */
  doFundsAuthOnly?: boolean;
  /** Paywall deep-link mode — must be set to 'DEEP_LINK'. Required by Payzone's
   *  /pwthree/api/initialize endpoint. Defaults to 'DEEP_LINK' in the adapter. */
  mode?: string;
  /** Default payment method string sent to paywall */
  paymentMethod?: string;
  /** Whether to show saved payment profiles on paywall */
  showPaymentProfiles?: string;

  // ── Server-to-server API (SETTLE / AUTH_REVERSAL / REFUND) ────
  /** API base URL for server-to-server commands */
  apiUrl: string;
  /** Caller name used in HMAC-SHA256 command auth header */
  callerName: string;
  /** Caller password used as HMAC-SHA256 key */
  callerPassword: string;

  // ── Webhook verification ──────────────────────────────────────
  /** HMAC-SHA256 secret for validating inbound Payzone webhook signatures */
  notificationKey?: string;
  /** When true, skip signature verification (local dev only) */
  callbackTestMode?: boolean;
}

export interface StripeCredentials {
  secretKey: string;
  webhookSecret: string;
  publishableKey?: string;
}

export type ProviderCredentials = NapsCredentials | VpsCredentials | StripeCredentials;

// ─── Adapter interface params/results ────────────────────────────────────────────

export interface CreateCheckoutParams {
  amount: number;       // in smallest unit (centimes / cents)
  currency: string;
  reference: string;
  description: string;
  /** URL the provider redirects the customer to after payment (generic fallback) */
  returnUrl: string;
  /** Provider-specific override: successful payment redirect */
  successUrl?: string;
  /** Provider-specific override: cancelled payment redirect */
  cancelUrl?: string;
  /** Provider-specific override: failed payment redirect */
  failureUrl?: string;
  webhookUrl: string;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  customerCountry?: string;
  customerLocale?: string;
  correlationId: string;
  /** When true, initiate pre-authorisation only (capture separately) */
  isPreauth?: boolean;
  /**
   * When true, instruct the provider to store the payment profile for future
   * server-initiated recurring charges (VPS: showPaymentProfiles = 'true').
   */
  storePaymentProfile?: boolean;
}

export interface ChargeRenewalResult {
  success: boolean;
  /** Provider-returned storedPaymentProfileId (if echoed back) */
  storedPaymentProfileId?: string;
  providerTransactionId?: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface CreateCheckoutResult {
  redirectUrl: string;
  providerRef: string;
  rawRequest:  Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  /**
   * Extra provider-specific data the front-end may need.
   * VPS: { paywallUrl, payload, signature } for form-POST based paywall.
   */
  providerData?: Record<string, unknown>;
}

export interface QueryStatusResult {
  status: PaymentIntentStatus;
  providerTransactionId?: string;
  rawResponse: Record<string, unknown>;
}

export interface RefundResult {
  success: boolean;
  providerRefundRef?: string;
  rawRequest:  Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface CaptureResult {
  success: boolean;
  rawRequest?:  Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface CancelResult {
  success: boolean;
  rawRequest?:  Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface TestConnectionResult {
  connected: boolean;
  error?: string;
}

/**
 * All provider adapters must implement this interface.
 */
export interface ProviderAdapter {
  readonly name: string;

  createCheckoutSession(params: CreateCheckoutParams): Promise<CreateCheckoutResult>;

  /**
   * Capture a pre-authorised payment (SETTLE / confirm).
   * Providers that do not support pre-auth should throw an AppError.
   */
  capturePayment(providerRef: string, amount: number, currency: string): Promise<CaptureResult>;

  /**
   * Cancel / void a pre-authorised payment (AUTH_REVERSAL).
   * Providers that do not support pre-auth should throw an AppError.
   */
  cancelPayment(providerRef: string, amount: number, currency: string): Promise<CancelResult>;

  queryTransactionStatus(providerRef: string): Promise<QueryStatusResult>;

  refund(providerRef: string, amount: number, currency: string): Promise<RefundResult>;

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;

  mapStatusToInternal(providerStatus: string): PaymentIntentStatus;

  testConnection(): Promise<TestConnectionResult>;
}
