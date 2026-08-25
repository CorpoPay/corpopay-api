import type { PaymentIntentStatus } from "@/generated/prisma/client";

/**
 * Single source of truth for provider → CorpoPay status mapping.
 *
 * Previously these maps were duplicated across the VPS/Stripe adapters and the
 * Stripe webhook processor, which drifts over time. Import from here instead.
 */

/** VPS / Payzone reported status → CorpoPay internal status. */
export const VPS_STATUS_MAP: Record<string, PaymentIntentStatus> = {
  // Pre-auth / authorized — awaiting SETTLE
  AUTHORISED: "REQUIRES_ACTION",
  AUTHORIZED: "REQUIRES_ACTION",
  AUTHORIZATION: "REQUIRES_ACTION",
  PREAUTHORIZED: "REQUIRES_ACTION",
  PRE_AUTHORIZED: "REQUIRES_ACTION",
  // 3DS intermediate — redirect customer
  REDIRECTED: "REQUIRES_ACTION",
  AUTHORIZE_PENDING: "REQUIRES_ACTION",
  AUTHORIZATION_PENDING: "REQUIRES_ACTION",
  CHALLENGE_REQUIRED: "REQUIRES_ACTION",
  CHALLENGED: "REQUIRES_ACTION",
  PENDING_3DS: "REQUIRES_ACTION",
  THREE_DS_PENDING: "REQUIRES_ACTION",
  // Terminal success
  CHARGED: "SUCCEEDED",
  CAPTURED: "SUCCEEDED",
  PAID: "SUCCEEDED",
  SETTLED: "SUCCEEDED",
  SETTLEMENT: "SUCCEEDED",
  COMPLETED: "SUCCEEDED",
  // Terminal failure
  REFUSED: "FAILED",
  DECLINED: "FAILED",
  FAILED: "FAILED",
  ERROR: "FAILED",
  // Canceled
  CANCELLED: "CANCELED",
  CANCELED: "CANCELED",
  AUTH_REVERSED: "CANCELED",
  VOIDED: "CANCELED",
  // In-flight
  PENDING: "PROCESSING",
  IN_PROGRESS: "PROCESSING",
  PROCESSING: "PROCESSING",
  SETTLEMENT_PROCESSING: "PROCESSING",
  // Refunded
  REFUNDED: "REFUNDED",
};

/** Stripe PaymentIntent status → CorpoPay internal status. */
const STRIPE_STATUS_MAP: Record<string, PaymentIntentStatus> = {
  succeeded: "SUCCEEDED",
  requires_action: "REQUIRES_ACTION",
  requires_source_action: "REQUIRES_ACTION",
  requires_payment_method: "REQUIRES_ACTION",
  requires_source: "REQUIRES_ACTION",
  processing: "PROCESSING",
  requires_capture: "PROCESSING",
  requires_confirmation: "PROCESSING",
  canceled: "CANCELED",
  cancelled: "CANCELED",
};

/** Stripe Checkout Session payment_status → CorpoPay internal status. */
const STRIPE_SESSION_STATUS_MAP: Record<string, PaymentIntentStatus> = {
  paid: "SUCCEEDED",
  unpaid: "REQUIRES_ACTION",
  no_payment_required: "SUCCEEDED",
  expired: "FAILED",
};

/** NAPS (Network of Automated Payment Systems) status → CorpoPay internal status. */
export const NAPS_STATUS_MAP: Record<string, PaymentIntentStatus> = {
  APPROVED: "SUCCEEDED",
  CAPTURED: "SUCCEEDED",
  DECLINED: "FAILED",
  REFUSED: "FAILED",
  EXPIRED: "FAILED",
  CANCELLED: "CANCELED",
  CANCELED: "CANCELED",
  PENDING: "PROCESSING",
  INPROGRESS: "PROCESSING",
  INITIATED: "REQUIRES_ACTION",
  REFUNDED: "REFUNDED",
  PARTIALLREFUNDED: "REFUNDED",
};

/** Map a Stripe PaymentIntent/Checkout-Session status string, defaulting to PROCESSING. */
export function mapStripeStatus(status: string): PaymentIntentStatus {
  return STRIPE_STATUS_MAP[status] ?? STRIPE_SESSION_STATUS_MAP[status] ?? "PROCESSING";
}
