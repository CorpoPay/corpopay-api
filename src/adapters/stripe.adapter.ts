/**
 * Stripe adapter — full implementation.
 *
 * Two creation modes, chosen via CreateCheckoutParams.walletMode:
 *
 *   walletMode = undefined (default)
 *     → stripe.checkout.sessions.create()
 *       Returns a Stripe-hosted checkout URL (checkout.stripe.com).
 *       providerRef = Stripe PaymentIntent ID (pi_xxx).
 *       Used by: Acme "Pay with Stripe" option, payment link relay page.
 *
 *   walletMode = 'apple_pay' | 'google_pay'
 *     → stripe.paymentIntents.create()
 *       Returns clientSecret + publishableKey for the Express Checkout Element.
 *       The frontend mounts ExpressCheckoutElement with these credentials and
 *       confirms the PaymentIntent directly — no page redirect.
 *       providerRef = PaymentIntent ID (pi_xxx).
 *       Used by: Acme "Apple Pay" / "Google Pay" radio options.
 *
 *   capturePayment         → stripe.paymentIntents.capture(id)
 *   cancelPayment          → stripe.paymentIntents.cancel(id)
 *   refund                 → stripe.refunds.create({ payment_intent: id, amount })
 *   queryTransactionStatus → stripe.paymentIntents.retrieve(id)
 *   verifyWebhookSignature → stripe.webhooks.constructEvent(rawBody, sig, secret)
 *   mapStatusToInternal    → PaymentIntent status → CorpoPay PaymentIntentStatus
 *   testConnection         → stripe.balance.retrieve()
 */

import Stripe from "stripe";
import type { PaymentIntentStatus } from "@/generated/prisma/client";
import { mapStripeStatus } from "../lib/status-maps";
import type {
  CancelResult,
  CaptureResult,
  CreateCheckoutParams,
  CreateCheckoutResult,
  CreatePayoutParams,
  PayoutResult,
  PayoutStatusResult,
  ProviderAdapter,
  QueryStatusResult,
  RefundResult,
  StripeCredentials,
  TestConnectionResult,
} from "./types";

// ─── Status mapping is shared: see src/lib/status-maps.ts ─────────────────────────

export class StripeAdapter implements ProviderAdapter {
  readonly name = "STRIPE";

  private readonly stripe: Stripe;
  private readonly credentials: StripeCredentials;

  constructor(credentials: StripeCredentials) {
    this.credentials = credentials;
    this.stripe = new Stripe(credentials.secretKey, {
      // Pin to a stable API version. Update intentionally when you want to
      // adopt new Stripe API surface.
      apiVersion: "2024-06-20" as any,
      typescript: true,
    });
  }

  // ─── createCheckoutSession ───────────────────────────────────────────────────

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const {
      amount,
      currency,
      description,
      successUrl,
      cancelUrl,
      returnUrl,
      customerEmail,
      correlationId,
      isPreauth,
    } = params;

    // Build line items — Stripe Checkout requires at least one.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: description,
            description: description,
          },
          unit_amount: amount, // already in smallest unit (cents/centimes)
        },
        quantity: 1,
      },
    ];

    // success_url / cancel_url: Stripe appends {CHECKOUT_SESSION_ID} which we
    // can use on the return page to poll for final status.
    const resolvedSuccessUrl = successUrl ?? returnUrl;
    const resolvedCancelUrl = cancelUrl ?? returnUrl;

    // ── In-page element modes (card PaymentElement / Apple Pay / Google Pay) ──
    if (
      params.checkoutMode === "element" ||
      params.walletMode === "apple_pay" ||
      params.walletMode === "google_pay"
    ) {
      return this.createPaymentIntent(params);
    }

    // ── Default: Stripe-hosted Checkout Session (redirect flow) ──────────────────
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      line_items: lineItems,
      mode: "payment",
      success_url: `${resolvedSuccessUrl}${resolvedSuccessUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: resolvedCancelUrl,
      // Pass our internal correlationId as metadata so we can match webhooks.
      metadata: {
        correlationId,
        corpopayRef: correlationId,
      },
      // Stripe will pre-fill the email field if provided.
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      // Manual capture for pre-auth flows
      payment_intent_data: {
        capture_method: isPreauth ? "manual" : "automatic",
        metadata: {
          correlationId,
          corpopayRef: correlationId,
        },
      },
    };

    const session = await this.stripe.checkout.sessions.create(sessionParams);

    // The PaymentIntent is created by Stripe at session creation time.
    // Use the PI id as our providerRef — it is stable and used for all subsequent ops.
    const providerRef = (session.payment_intent as string) ?? session.id;

    return {
      redirectUrl: session.url!,
      providerRef,
      rawRequest: { ...sessionParams, line_items: lineItems } as Record<string, unknown>,
      rawResponse: session as unknown as Record<string, unknown>,
      providerData: {
        sessionId: session.id,
        paymentIntentId: session.payment_intent ?? null,
        publishableKey: this.credentials.publishableKey ?? null,
      },
    };
  }

  // ─── createPaymentIntent (wallet mode) ───────────────────────────────────────
  //
  // Creates a bare PaymentIntent and returns its clientSecret so the frontend
  // can mount Stripe's ExpressCheckoutElement (Apple Pay / Google Pay).
  // The PaymentIntent is confirmed client-side; Stripe fires a webhook on success
  // which CorpoPay's webhook handler picks up exactly like a Checkout Session.

  private async createPaymentIntent(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const { amount, currency, description, customerEmail, correlationId, isPreauth } = params;

    const piParams: Stripe.PaymentIntentCreateParams = {
      amount,
      currency: currency.toLowerCase(),
      description,
      capture_method: isPreauth ? "manual" : "automatic",
      // Enable Apple Pay, Google Pay, and Link via automatic payment methods.
      automatic_payment_methods: { enabled: true },
      metadata: {
        correlationId,
        corpopayRef: correlationId,
      },
      ...(customerEmail
        ? {
            receipt_email: customerEmail,
          }
        : {}),
    };

    const pi = await this.stripe.paymentIntents.create(piParams);

    if (!pi.client_secret) {
      throw new Error("Stripe did not return a client_secret for the PaymentIntent.");
    }

    return {
      // No redirect URL — the payment is confirmed in-page via ExpressCheckoutElement.
      // We set an empty string so callers that blindly read redirectUrl don't crash;
      // the real signal is stripeData.clientSecret being present.
      redirectUrl: "",
      providerRef: pi.id,
      rawRequest: piParams as unknown as Record<string, unknown>,
      rawResponse: pi as unknown as Record<string, unknown>,
      providerData: {
        paymentIntentId: pi.id,
        publishableKey: this.credentials.publishableKey ?? null,
        clientSecret: pi.client_secret,
      },
      stripeData: {
        clientSecret: pi.client_secret,
        publishableKey: this.credentials.publishableKey ?? "",
      },
    };
  }

  // ─── capturePayment ──────────────────────────────────────────────────────────

  async capturePayment(
    providerRef: string,
    amount: number,
    _currency: string,
  ): Promise<CaptureResult> {
    const rawRequest: Record<string, unknown> = {
      paymentIntentId: providerRef,
      amount,
    };

    const pi = await this.stripe.paymentIntents.capture(providerRef, {
      amount_to_capture: amount,
    });

    return {
      success: pi.status === "succeeded",
      status: this.mapStatusToInternal(pi.status),
      rawRequest,
      rawResponse: pi as unknown as Record<string, unknown>,
    };
  }

  // ─── cancelPayment ───────────────────────────────────────────────────────────

  async cancelPayment(
    providerRef: string,
    _amount: number,
    _currency: string,
  ): Promise<CancelResult> {
    const rawRequest: Record<string, unknown> = {
      paymentIntentId: providerRef,
    };

    const pi = await this.stripe.paymentIntents.cancel(providerRef);

    return {
      success: pi.status === "canceled",
      status: this.mapStatusToInternal(pi.status),
      rawRequest,
      rawResponse: pi as unknown as Record<string, unknown>,
    };
  }

  // ─── queryTransactionStatus ──────────────────────────────────────────────────

  async queryTransactionStatus(providerRef: string): Promise<QueryStatusResult> {
    // providerRef may be a PaymentIntent ID (pi_xxx) or Checkout Session ID (cs_xxx).
    // For Stripe Checkout, we store the session ID as providerRef because the
    // PaymentIntent is only created after the customer begins checkout — it is
    // null at session creation time.

    if (providerRef.startsWith("cs_")) {
      // Session ID — retrieve session and map via payment_status.
      // payment_intent may still be null if the customer hasn't started the
      // checkout flow yet; in that case we return REQUIRES_ACTION so Inngest
      // keeps polling instead of marking the intent as FAILED.
      const session = await this.stripe.checkout.sessions.retrieve(providerRef, {
        expand: ["payment_intent"],
      });

      // Session-level status is always available; use it as the primary signal.
      const sessionStatus = this.mapStatusToInternal(session.payment_status);

      // If the PI is already attached, also map its status for precision.
      const pi = session.payment_intent as Stripe.PaymentIntent | null;
      if (pi) {
        const piStatus = this.mapStatusToInternal(pi.status);
        return {
          status: piStatus,
          providerTransactionId: pi.latest_charge as string | undefined,
          rawResponse: session as unknown as Record<string, unknown>,
        };
      }

      // PI not yet created — customer hasn't started checkout.
      return {
        status: sessionStatus,
        providerTransactionId: undefined,
        rawResponse: session as unknown as Record<string, unknown>,
      };
    }

    // PI ID (pi_xxx) — retrieve directly.
    const pi = await this.stripe.paymentIntents.retrieve(providerRef);
    return {
      status: this.mapStatusToInternal(pi.status),
      providerTransactionId: pi.latest_charge as string | undefined,
      rawResponse: pi as unknown as Record<string, unknown>,
    };
  }

  // ─── refund ──────────────────────────────────────────────────────────────────

  async refund(providerRef: string, amount: number, _currency: string): Promise<RefundResult> {
    const rawRequest: Record<string, unknown> = {
      payment_intent: providerRef,
      amount,
    };

    const refund = await this.stripe.refunds.create({
      payment_intent: providerRef,
      amount, // partial refund if amount < charge amount; full refund if omitted
    });

    const success = refund.status === "succeeded" || refund.status === "pending";

    return {
      success,
      providerRefundRef: refund.id,
      rawRequest,
      rawResponse: refund as unknown as Record<string, unknown>,
    };
  }

  // ─── verifyWebhookSignature ──────────────────────────────────────────────────
  //
  // Stripe signs every webhook with a HMAC-SHA256 signature in the
  // `Stripe-Signature` header. stripe.webhooks.constructEvent() handles the
  // timestamp tolerance check (default 300 s) to prevent replay attacks.
  //
  // IMPORTANT: rawBody must be the raw Buffer as received by Express — do NOT
  // parse it as JSON before passing it here. Register the /webhooks/stripe route
  // with express.raw({ type: 'application/json' }) or capture req.rawBody.

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const sig = headers["stripe-signature"] ?? headers["Stripe-Signature"] ?? "";
    const secret = this.credentials.webhookSecret;

    if (!sig || !secret) return false;

    try {
      this.stripe.webhooks.constructEvent(rawBody, sig, secret);
      return true;
    } catch {
      return false;
    }
  }

  // ─── mapStatusToInternal ─────────────────────────────────────────────────────

  mapStatusToInternal(providerStatus: string): PaymentIntentStatus {
    return mapStripeStatus(providerStatus);
  }

  // ─── testConnection ──────────────────────────────────────────────────────────
  //
  // stripe.balance.retrieve() is a lightweight authenticated call that confirms
  // the secret key is valid without touching real data.

  async createPayout(_params: CreatePayoutParams): Promise<PayoutResult> {
    throw new Error(`${this.name} payouts are not yet implemented`);
  }

  async getPayoutStatus(_providerTransferId: string): Promise<PayoutStatusResult> {
    throw new Error(`${this.name} payout status is not yet implemented`);
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      await this.stripe.balance.retrieve();
      return { connected: true };
    } catch (err: unknown) {
      const message = (err as Error).message ?? "Unknown error";
      return { connected: false, error: message };
    }
  }
}
