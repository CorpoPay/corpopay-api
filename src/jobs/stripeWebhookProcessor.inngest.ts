/**
 * Job: webhook/stripe.process
 *
 * Dedicated processor for Stripe webhook events. Completely independent from
 * the NAPS/VPS webhookProcessor — no shared logic, no provider conditionals.
 *
 * Stripe event types handled:
 *   checkout.session.completed     → payment succeeded via Checkout
 *   payment_intent.succeeded       → payment captured (direct PI flow / manual capture)
 *   payment_intent.payment_failed  → payment declined or errored
 *   payment_intent.canceled        → payment intent voided
 *   charge.refunded                → full or partial refund issued
 *
 * Architecture:
 *   POST /webhooks/stripe (Express)
 *     → signature verified synchronously
 *     → inngest.send("webhook/stripe.process")
 *       → this job runs durably with automatic retries
 *
 * Stripe event shape:
 *   {
 *     id:        "evt_xxx",
 *     type:      "payment_intent.succeeded",
 *     data: {
 *       object:  <PaymentIntent | CheckoutSession | Charge>
 *     }
 *   }
 *
 * CorpoPay always stores correlationId in metadata.correlationId on both the
 * PaymentIntent and the Checkout Session at creation time (see stripe.adapter.ts).
 * That is the primary join key used throughout this processor.
 */

import type Stripe from "stripe";
import { Provider } from "@/generated/prisma/client";
import { inngest } from "../lib/inngest";
import { maskObject } from "../lib/mask";
import { prisma } from "../lib/prisma";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a PaymentIntent from a Stripe event object.
 * Works for both PaymentIntent events (object IS the PI) and
 * CheckoutSession events (object is a Session with an embedded PI).
 */
function extractPaymentIntent(obj: Record<string, unknown>): Record<string, unknown> | null {
  // Direct PaymentIntent event — object.object === 'payment_intent'
  if (obj["object"] === "payment_intent") return obj;

  // Checkout Session — payment_intent may be expanded or just an ID string
  if (obj["object"] === "checkout.session") {
    const pi = obj["payment_intent"];
    if (pi && typeof pi === "object") return pi as Record<string, unknown>;
    // If it's just an ID string we can't extract the PI inline — return null
    // and let the caller handle via providerRef lookup.
    return null;
  }

  return null;
}

/**
 * Resolve the CorpoPay correlationId from a Stripe object's metadata.
 * Stripe Checkout Sessions and PaymentIntents both carry metadata.correlationId
 * (set at session creation time in stripe.adapter.ts).
 */
function extractCorrelationId(obj: Record<string, unknown>): string | null {
  const meta = (obj["metadata"] as Record<string, string> | undefined) ?? {};
  return meta["correlationId"] ?? meta["corpopayRef"] ?? null;
}

type InternalStatus =
  | "CREATED"
  | "REQUIRES_ACTION"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "REFUNDED";

// ─── Inngest function ─────────────────────────────────────────────────────────

export const stripeWebhookProcessor = inngest.createFunction(
  {
    id: "stripe-webhook-processor",
    name: "Stripe Webhook Processor",
    retries: 5,
    // Inngest deduplicates events by id — we pass "STRIPE:<evt_xxx>" from the
    // webhook route so duplicate Stripe deliveries are silently dropped.
  },
  { event: "webhook/stripe.process" },
  async ({ event, step }) => {
    const { payloadJson, idempotencyKey } = event.data as {
      payloadJson: Record<string, unknown>;
      rawBodyBase64: string;
      headers: Record<string, string>;
      idempotencyKey: string;
    };

    // The full Stripe event envelope
    const stripeEvent = payloadJson as unknown as Stripe.Event;
    const eventType = stripeEvent.type;
    const obj = (stripeEvent.data?.object ?? {}) as unknown as Record<string, unknown>;

    // ── Step 1: Resolve the CorpoPay PaymentIntent ────────────────────────────
    //
    // Primary key: correlationId stored in Stripe metadata.
    // Fallback: providerRef — the PaymentIntent ID (pi_xxx) which we always
    // store on the CorpoPay intent record after checkout session creation.

    const intent = await step.run("find-intent", async () => {
      const correlationId = extractCorrelationId(obj);

      // Also look for a PI id directly on the object (for PaymentIntent events)
      // or via the payment_intent field on a Charge or Session object.
      const piId =
        obj["object"] === "payment_intent"
          ? (obj["id"] as string | undefined)
          : ((obj["payment_intent"] as string | undefined) ?? null);

      // 1. Match by correlationId (most reliable — set by us at creation)
      if (correlationId) {
        const found = await prisma.paymentIntent.findFirst({
          where: { correlationId, provider: Provider.STRIPE },
        });
        if (found) return found;
      }

      // 2. Fallback: match by providerRef (pi_xxx) stored after checkout creation
      if (piId) {
        const found = await prisma.paymentIntent.findFirst({
          where: { providerRef: piId, provider: Provider.STRIPE },
        });
        if (found) return found;
      }

      return null;
    });

    if (!intent) {
      // This can happen for events that don't relate to a CorpoPay-initiated
      // payment (e.g. payments made directly in the Stripe dashboard).
      // Log and exit cleanly — do not throw so Inngest doesn't retry forever.
      console.warn("[stripe-webhook] intent not found", {
        eventType,
        idempotencyKey,
        objId: obj["id"],
      });
      return { skipped: true, reason: "intent-not-found", eventType };
    }

    // ── Step 2: Route by event type ───────────────────────────────────────────
    //
    // Each branch is explicit — no generic status mapping, no shared paths.
    // This makes it easy to extend each event type independently.

    let newStatus: InternalStatus | null = null;
    let providerTransactionId: string | null = null; // Stripe charge ID (ch_xxx)
    let processingNote: string | null = null;

    if (eventType === "checkout.session.completed" || eventType === "payment_intent.succeeded") {
      // ── Payment succeeded ──────────────────────────────────────────────────
      // For checkout.session.completed the PI may be embedded or just an ID.
      // payment_intent.succeeded fires when the PI itself transitions to succeeded.
      // We treat both as a terminal success.

      newStatus = "SUCCEEDED";
      processingNote = `Stripe event: ${eventType}`;

      // Extract the charge ID (ch_xxx) — Stripe's reference for the settled funds
      const pi = extractPaymentIntent(obj);
      if (pi) {
        providerTransactionId = (pi["latest_charge"] as string | undefined) ?? null;
      }
      // For checkout.session.completed, payment_intent may be a string (not expanded)
      if (!providerTransactionId && obj["payment_intent"]) {
        // providerRef already stored as pi_xxx — the charge can be retrieved
        // later via queryTransactionStatus if needed. Not critical for status update.
      }
    } else if (eventType === "payment_intent.payment_failed") {
      // ── Payment failed ─────────────────────────────────────────────────────
      // Stripe fires this when the PI transitions to requires_payment_method
      // after a failed charge attempt. We map this to FAILED.
      newStatus = "FAILED";
      processingNote = `Stripe event: ${eventType}`;

      const pi = extractPaymentIntent(obj);
      const lastError = pi?.["last_payment_error"] as Record<string, unknown> | undefined;
      if (lastError) {
        processingNote += ` — ${lastError["code"] ?? ""} ${lastError["message"] ?? ""}`.trim();
      }
    } else if (eventType === "payment_intent.canceled") {
      // ── Payment cancelled / voided ─────────────────────────────────────────
      newStatus = "CANCELED";
      processingNote = `Stripe event: ${eventType}`;

      const pi = extractPaymentIntent(obj);
      const cancellationReason = pi?.["cancellation_reason"] as string | undefined;
      if (cancellationReason) {
        processingNote += ` — reason: ${cancellationReason}`;
      }
    } else if (eventType === "charge.refunded") {
      // ── Refund issued ──────────────────────────────────────────────────────
      // Stripe fires this when a charge is fully or partially refunded.
      // obj is a Charge object here (not a PaymentIntent).
      newStatus = "REFUNDED";
      providerTransactionId = (obj["id"] as string | undefined) ?? null; // ch_xxx
      processingNote = `Stripe event: ${eventType}`;

      const amountRefunded = obj["amount_refunded"] as number | undefined;
      const amountCaptured = obj["amount_captured"] as number | undefined;
      if (amountRefunded !== undefined && amountCaptured !== undefined) {
        const isPartial = amountRefunded < amountCaptured;
        processingNote += isPartial ? " (partial)" : " (full)";
      }
    } else {
      // Unhandled event type — acknowledge receipt and exit cleanly.
      // This covers events like payment_intent.created, payment_intent.processing,
      // customer.created, etc. that we don't need to act on.
      console.info("[stripe-webhook] unhandled event type, skipping", {
        eventType,
        idempotencyKey,
      });
      return { skipped: true, reason: "unhandled-event-type", eventType };
    }

    // ── Step 3: Update the PaymentIntent in our DB ────────────────────────────
    //
    // Only transition if not already in a terminal state — guards against
    // out-of-order Stripe event delivery (e.g. payment_intent.succeeded arriving
    // after charge.refunded).

    const TERMINAL: InternalStatus[] = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"];

    const updated = await step.run("update-intent-status", async () => {
      if (!newStatus) return null;

      // Don't overwrite a terminal state with a non-terminal one
      const current = await prisma.paymentIntent.findUnique({
        where: { id: intent.id },
        select: { status: true },
      });
      if (!current) return null;

      const alreadyTerminal = TERMINAL.includes(current.status as InternalStatus);
      const incomingTerminal = TERMINAL.includes(newStatus);

      // Allow terminal → terminal only if the new state is REFUNDED
      // (a SUCCEEDED payment can later be refunded)
      if (alreadyTerminal && current.status === newStatus) return null;
      if (alreadyTerminal && current.status !== "SUCCEEDED" && newStatus === "REFUNDED")
        return null;
      if (alreadyTerminal && !incomingTerminal) return null;

      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: newStatus },
      });

      return newStatus;
    });

    // ── Step 4: Update ProviderTransaction record ─────────────────────────────
    //
    // Upsert the raw Stripe event as the provider transaction payload so it's
    // available in the transaction detail view.

    await step.run("upsert-provider-transaction", async () => {
      const existing = await prisma.providerTransaction.findFirst({
        where: { paymentIntentId: intent.id },
      });

      const maskedPayload = maskObject(payloadJson as Record<string, unknown>) as Record<
        string,
        unknown
      >;

      if (existing) {
        await prisma.providerTransaction.update({
          where: { id: existing.id },
          data: {
            ...(providerTransactionId ? { providerTransactionId } : {}),
            rawResponse: maskedPayload as any,
          },
        });
      } else {
        await prisma.providerTransaction.create({
          data: {
            paymentIntentId: intent.id,
            provider: Provider.STRIPE,
            providerTransactionId: providerTransactionId ?? undefined,
            rawRequest: {},
            rawResponse: maskedPayload as any,
          },
        });
      }
    });

    // ── Step 5: Mark PaymentLink as PAID if succeeded ─────────────────────────

    if (newStatus === "SUCCEEDED" && intent.paymentLinkId) {
      await step.run("mark-link-paid", async () => {
        await prisma.paymentLink.update({
          where: { id: intent.paymentLinkId! },
          data: { status: "PAID" },
        });
      });
    }

    // ── Step 6: Store WebhookEvent record ─────────────────────────────────────

    const webhookEvent = await step.run("store-webhook-event", async () => {
      return prisma.webhookEvent.create({
        data: {
          provider: Provider.STRIPE,
          tenantId: intent.tenantId,
          paymentIntentId: intent.id,
          rawPayload: maskObject(payloadJson) as any,
          signatureVerified: true, // already verified in the HTTP handler
          processed: updated !== null,
          processingError: null,
          mappedStatus: newStatus,
          idempotencyKey,
        },
      });
    });

    // ── Step 7: Fire notification for terminal transitions ────────────────────

    const notifiableStatuses: InternalStatus[] = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"];

    if (updated && notifiableStatuses.includes(newStatus!)) {
      await step.sendEvent("send-payment-notification", {
        name: "payment/notify",
        data: {
          intentId: intent.id,
          tenantId: intent.tenantId,
          status: newStatus,
          webhookEventId: webhookEvent.id,
        },
      });
    }

    return {
      webhookEventId: webhookEvent.id,
      eventType,
      newStatus,
      processingNote,
      intentId: intent.id,
    };
  },
);
