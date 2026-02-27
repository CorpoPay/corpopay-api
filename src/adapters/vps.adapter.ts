/**
 * VPS / Payzone adapter — full implementation.
 *
 * Payment flow:
 *   1. createCheckoutSession  → builds a SHA-256-signed paywall payload; the
 *      front-end POSTs the signed form to pzConfig.paywallUrl (hosted paywall).
 *   2. Payzone calls webhookUrl (POST /webhooks/vps) after authorisation.
 *      verifyWebhookSignature validates the HMAC-SHA256 signature using
 *      credentials.notificationKey.
 *   3a. Pre-auth flow: capturePayment  → SETTLE  command  (server-to-server HMAC)
 *   3b. Pre-auth flow: cancelPayment   → AUTH_REVERSAL command
 *   4.  refund                         → REFUND   command
 *
 * Server-to-server command auth: HMAC-SHA256 over
 *   callerName + merchantAccount + timestamp + requestPath + requestBodyStr
 * signed with callerPassword.
 */
import crypto from 'crypto';
import { PaymentIntentStatus } from '@prisma/client';
import {
  ProviderAdapter,
  VpsCredentials,
  CreateCheckoutParams,
  CreateCheckoutResult,
  CaptureResult,
  CancelResult,
  QueryStatusResult,
  RefundResult,
  ChargeRenewalResult,
  TestConnectionResult,
} from './types';

// ─── Status mapping ───────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, PaymentIntentStatus> = {
  // Pre-auth / authorized — awaiting SETTLE
  AUTHORISED:             'REQUIRES_ACTION',
  AUTHORIZED:             'REQUIRES_ACTION',
  AUTHORIZATION:          'REQUIRES_ACTION',
  PREAUTHORIZED:          'REQUIRES_ACTION',
  PRE_AUTHORIZED:         'REQUIRES_ACTION',
  // 3DS intermediate — redirect customer
  REDIRECTED:             'REQUIRES_ACTION',
  AUTHORIZE_PENDING:      'REQUIRES_ACTION',
  AUTHORIZATION_PENDING:  'REQUIRES_ACTION',
  CHALLENGE_REQUIRED:     'REQUIRES_ACTION',
  CHALLENGED:             'REQUIRES_ACTION',
  PENDING_3DS:            'REQUIRES_ACTION',
  THREE_DS_PENDING:       'REQUIRES_ACTION',
  // Terminal success
  CHARGED:                'SUCCEEDED',
  CAPTURED:               'SUCCEEDED',
  PAID:                   'SUCCEEDED',
  SETTLED:                'SUCCEEDED',
  SETTLEMENT:             'SUCCEEDED',
  COMPLETED:              'SUCCEEDED',
  // Terminal failure
  REFUSED:                'FAILED',
  DECLINED:               'FAILED',
  FAILED:                 'FAILED',
  ERROR:                  'FAILED',
  // Canceled
  CANCELLED:              'CANCELED',
  CANCELED:               'CANCELED',
  AUTH_REVERSED:          'CANCELED',
  VOIDED:                 'CANCELED',
  // In-flight
  PENDING:                'PROCESSING',
  IN_PROGRESS:            'PROCESSING',
  PROCESSING:             'PROCESSING',
  SETTLEMENT_PROCESSING:  'PROCESSING',
  // Refunded
  REFUNDED:               'REFUNDED',
};

// ─── Payzone command response shape ──────────────────────────────────────────────

interface PayzoneCommandResponse {
  status: 'CHARGED' | 'AUTH_REVERSED' | 'REFUNDED' | 'FAILED' | string;
  message?: string;
  chargeId?: string;
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────

/** SHA-256:  secretKey + JSON(payload)  — used for paywall redirect signing */
function generatePaywallSignature(
  payload: Record<string, unknown>,
  secretKey: string,
): string {
  return crypto
    .createHash('sha256')
    .update(secretKey + JSON.stringify(payload))
    .digest('hex');
}

/**
 * HMAC-SHA256 for server-to-server commands.
 * Message: callerName + merchantAccount + timestamp + requestPath + requestBodyStr
 */
function generateCommandHmac(
  callerName: string,
  merchantAccount: string,
  timestamp: number,
  requestPath: string,
  requestBodyStr: string,
  callerPassword: string,
): string {
  const message =
    callerName + merchantAccount + timestamp + requestPath + requestBodyStr;
  return crypto
    .createHmac('sha256', callerPassword)
    .update(message)
    .digest('hex')
    .toUpperCase();
}

function timingSafeCompare(a: string, b: string): boolean {
  try {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────────

export class VpsAdapter implements ProviderAdapter {
  readonly name = 'VPS';

  constructor(private readonly credentials: VpsCredentials) {}

  // ── createCheckoutSession ──────────────────────────────────────────────────────

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const c = this.credentials;

    const payload: Record<string, unknown> = {
      merchantAccount:    c.merchantAccount,
      timestamp:          Math.floor(Date.now() / 1000),
      skin:               c.skin ?? 'vps-1-vue',
      doFundsAuthOnly:    params.isPreauth ?? c.doFundsAuthOnly ?? false,
      customerId:         params.correlationId,
      customerCountry:    params.customerCountry ?? 'MA',
      customerLocale:     params.customerLocale  ?? 'en_US',
      customerName:       params.customerName  ?? 'Guest Customer',
      customerEmail:      params.customerEmail ?? '',
      chargeId:           params.correlationId,
      orderId:            params.reference,
      price:              (params.amount / 100).toFixed(2), // centimes → MAD
      currency:           params.currency,
      description:        params.description,
      mode:               c.mode            || 'DEEP_LINK',
      ...(c.paymentMethod ? { paymentMethod: c.paymentMethod } : { paymentMethod: 'CREDIT_CARD' }),
      // savePaymentProfile: triggers the creation of a new stored payment profile on this charge
      // showPaymentProfiles: shows previously saved cards in the paywall UI
      savePaymentProfile:  params.storePaymentProfile ? 'true' : 'false',
      showPaymentProfiles: params.storePaymentProfile ? 'true' : (c.showPaymentProfiles ?? 'false'),
      callbackUrl:        params.webhookUrl,
      successUrl:         params.successUrl  ?? params.returnUrl,
      failureUrl:         params.failureUrl  ?? params.returnUrl,
      cancelUrl:          params.cancelUrl   ?? params.returnUrl,
    };

    const signature = generatePaywallSignature(payload, c.paywallSecretKey);

    console.log('[VPS] createCheckoutSession payload:', JSON.stringify(payload, null, 2));
    console.log('[VPS] paywallUrl:', c.paywallUrl);

    // The front-end reads providerData and POSTs { payload: JSON, signature, mode }
    // to credentials.paywallUrl (Payzone hosted paywall).
    // NOTE: `mode` must also be a top-level POST field (not only inside the JSON
    // payload) because Payzone's paywall JS reads it directly from the form data
    // when calling /pwthree/api/initialize?mode=DEEP_LINK&...
    return {
      redirectUrl:  c.paywallUrl,
      providerRef:  params.correlationId,
      rawRequest:   payload,
      rawResponse:  {},
      providerData: {
        paywallUrl: c.paywallUrl,
        payload:    JSON.stringify(payload),
        signature,
        chargeId:   params.correlationId,
        mode:       payload.mode as string,
      },
    };
  }

  // ── chargeRenewal ──────────────────────────────────────────────────────────────
  //
  // Server-initiated recurring charge using a stored payment profile.
  // No customer interaction required — billed silently against the stored card.
  //
  // VPS docs: POST /api/v3/charges/{chargeId}
  //   body: { command: 'CHARGE', paymentProfileId, amount, currency, idempotencyId }
  //
  // NOTE: Payzone sends "storedPaymentProfileId" in its CALLBACK payloads (outbound)
  // but expects "paymentProfileId" in the CHARGE command body (inbound).

  async chargeRenewal(
    storedPaymentProfileId: string,
    amount: number,              // in centimes
    currency: string,
    chargeId: string,            // merchant-chosen unique charge ID for this renewal
    idempotencyId: string,       // e.g. "{subscriptionId}-{YYYY-MM-DD}"
  ): Promise<ChargeRenewalResult> {
    const c = this.credentials;

    const requestPath    = `/api/v3/charges/${encodeURIComponent(chargeId)}`;
    const requestBody    = {
      command:          'CHARGE',
      paymentProfileId: storedPaymentProfileId,
      amount:           parseFloat((amount / 100).toFixed(2)), // number, not string
      currency,
      idempotencyId,
    };
    const requestBodyStr = JSON.stringify(requestBody);
    const timestamp      = Math.floor(Date.now() / 1000);

    const signature = generateCommandHmac(
      c.callerName,
      c.merchantAccount,
      timestamp,
      requestPath,
      requestBodyStr,
      c.callerPassword,
    );

    const response = await fetch(`${c.apiUrl.replace(/\/$/, '')}${requestPath}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-MerchantAccount': c.merchantAccount,
        'X-CallerName':      c.callerName,
        'X-HMAC-Timestamp':  String(timestamp),
        'X-HMAC-Signature':  signature,
      },
      body: requestBodyStr,
      signal: AbortSignal.timeout(30_000),
    });

    const raw = (await response.json()) as Record<string, unknown>;
    const status = ((raw['status'] as string) ?? 'ERROR').toUpperCase();

    return {
      success:               status === 'CHARGED',
      providerTransactionId: raw['id'] as string | undefined,
      rawRequest:            requestBody as Record<string, unknown>,
      rawResponse:           raw,
    };
  }

  // ── capturePayment (SETTLE) ───────────────────────────────────────────────────

  async capturePayment(
    providerRef: string,
    amount: number,
    _currency: string,
  ): Promise<CaptureResult> {
    const raw = await this.runCommand(providerRef, amount, 'SETTLE');

    // Accept any terminal-success status from VPS for a SETTLE command.
    // The canonical response is CHARGED but sandbox may return CAPTURED/PAID/SETTLED.
    const SETTLE_SUCCESS = ['CHARGED', 'CAPTURED', 'PAID', 'SETTLED', 'SETTLEMENT', 'COMPLETED'];
    if (!SETTLE_SUCCESS.includes((raw.status ?? '').toUpperCase())) {
      throw new Error(
        `VPS capture failed: provider returned status "${raw.status}" — ${raw.message ?? ''}`,
      );
    }

    return { success: true, rawResponse: raw as Record<string, unknown> };
  }

  // ── cancelPayment (AUTH_REVERSAL) ─────────────────────────────────────────────

  async cancelPayment(
    providerRef: string,
    amount: number,
    _currency: string,
  ): Promise<CancelResult> {
    const raw = await this.runCommand(providerRef, amount, 'AUTH_REVERSAL');

    if (raw.status !== 'AUTH_REVERSED') {
      throw new Error(
        `VPS cancel failed: provider returned status "${raw.status}" — ${raw.message ?? ''}`,
      );
    }

    return { success: true, rawResponse: raw as Record<string, unknown> };
  }

  // ── refund (REFUND) ───────────────────────────────────────────────────────────

  async refund(
    providerRef: string,
    amount: number,
    _currency: string,
  ): Promise<RefundResult> {
    const raw = await this.runCommand(providerRef, amount, 'REFUND');

    const success = raw.status === 'REFUNDED';

    return {
      success,
      providerRefundRef: raw.chargeId ?? providerRef,
      rawRequest:        { command: 'REFUND', chargeId: providerRef, amount },
      rawResponse:       raw as Record<string, unknown>,
    };
  }

  // ── queryTransactionStatus ────────────────────────────────────────────────────

  async queryTransactionStatus(providerRef: string): Promise<QueryStatusResult> {
    const c = this.credentials;
    const requestPath = `/api/v3/charges/${encodeURIComponent(providerRef)}`;
    const timestamp   = Math.floor(Date.now() / 1000);
    const signature   = generateCommandHmac(
      c.callerName,
      c.merchantAccount,
      timestamp,
      requestPath,
      '',
      c.callerPassword,
    );

    const response = await fetch(`${c.apiUrl.replace(/\/$/, '')}${requestPath}`, {
      method:  'GET',
      headers: {
        'Content-Type':      'application/json',
        'X-MerchantAccount': c.merchantAccount,
        'X-CallerName':      c.callerName,
        'X-HMAC-Timestamp':  String(timestamp),
        'X-HMAC-Signature':  signature,
      },
    });

    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(`VPS GET HTTP ${response.status}: ${JSON.stringify(raw)}`);
    }

    // Support both flat { status } and wrapped { charge: { status } } responses
    const chargeData = (raw['charge'] as Record<string, unknown> | undefined) ?? raw;
    const providerStatus = ((chargeData['status'] as string) ?? 'UNKNOWN').toUpperCase();

    return {
      status:                this.mapStatusToInternal(providerStatus),
      providerTransactionId: (chargeData['id'] as string | undefined) ?? (chargeData['transactionId'] as string | undefined),
      rawResponse:           raw,
    };
  }

  // ── verifyWebhookSignature ────────────────────────────────────────────────────

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): boolean {
    const c = this.credentials;

    // Allow bypass in local/test mode
    if (c.callbackTestMode) return true;

    const notificationKey = c.notificationKey;
    if (!notificationKey) {
      // No key configured — reject to fail safe
      return false;
    }

    // Accept any of the common Payzone signature header names
    const sig =
      headers['x-callback-signature'] ??
      headers['x-payzone-signature']  ??
      headers['x-vps-signature']       ??
      headers['x-signature']           ??
      '';

    if (!sig) return false;

    const expected = crypto
      .createHmac('sha256', notificationKey)
      .update(rawBody)
      .digest('hex');

    return timingSafeCompare(sig.toLowerCase(), expected.toLowerCase());
  }

  // ── mapStatusToInternal ───────────────────────────────────────────────────────

  mapStatusToInternal(providerStatus: string): PaymentIntentStatus {
    return STATUS_MAP[providerStatus.toUpperCase()] ?? 'PROCESSING';
  }

  // ── testConnection ────────────────────────────────────────────────────────────
  //
  // Payzone does not expose a dedicated health endpoint, so we probe the
  // charges resource with a dummy id.  Expected outcomes:
  //   404  → API reachable and credentials accepted (charge simply not found)
  //   401/403 → API reachable but credentials rejected
  //   anything else or network error → treat as unreachable

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const c           = this.credentials;
      const requestPath = '/api/v3/charges/connectivity-test-probe';
      const timestamp   = Math.floor(Date.now() / 1000);
      const signature   = generateCommandHmac(
        c.callerName,
        c.merchantAccount,
        timestamp,
        requestPath,
        '',
        c.callerPassword,
      );

      const response = await fetch(`${c.apiUrl.replace(/\/$/, '')}${requestPath}`, {
        method:  'GET',
        headers: {
          'X-MerchantAccount': c.merchantAccount,
          'X-CallerName':      c.callerName,
          'X-HMAC-Timestamp':  String(timestamp),
          'X-HMAC-Signature':  signature,
        },
        signal: AbortSignal.timeout(10_000),
      });

      // 404 is the expected "happy path": endpoint exists, credentials valid,
      // resource simply not found — treat as successful connectivity.
      if (response.ok || response.status === 404) return { connected: true };

      if (response.status === 401 || response.status === 403) {
        return { connected: false, error: 'Invalid credentials (authentication rejected)' };
      }

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        connected: false,
        error:     (body['message'] as string) ?? `HTTP ${response.status}`,
      };
    } catch (err: unknown) {
      return { connected: false, error: (err as Error).message };
    }
  }

  // ── Private: shared server-to-server command call ─────────────────────────────

  private async runCommand(
    chargeId: string,
    amount: number,
    command: 'SETTLE' | 'AUTH_REVERSAL' | 'REFUND',
  ): Promise<PayzoneCommandResponse> {
    const c = this.credentials;

    const requestPath    = `/api/v3/charges/${encodeURIComponent(chargeId)}`;
    const requestBody    = { command, amount: parseFloat((amount / 100).toFixed(2)) }; // number, not string
    const requestBodyStr = JSON.stringify(requestBody);
    const timestamp      = Math.floor(Date.now() / 1000);

    const signature = generateCommandHmac(
      c.callerName,
      c.merchantAccount,
      timestamp,
      requestPath,
      requestBodyStr,
      c.callerPassword,
    );

    const response = await fetch(`${c.apiUrl.replace(/\/$/, '')}${requestPath}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-MerchantAccount': c.merchantAccount,
        'X-CallerName':      c.callerName,
        'X-HMAC-Timestamp':  String(timestamp),
        'X-HMAC-Signature':  signature,
      },
      body: requestBodyStr,
      signal: AbortSignal.timeout(30_000),
    });

    return (await response.json()) as PayzoneCommandResponse;
  }
}

