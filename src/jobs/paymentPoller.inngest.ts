/**
 * Job: payment/poll-status
 *
 * Triggered immediately after a PaymentIntent is created and the user is
 * redirected to the provider's payment page.  Polls the provider every 30 s
 * until the intent reaches a terminal state, or a timeout elapses, at which
 * point the intent is marked FAILED.
 *
 * This lets CorpoPay self-heal when a provider webhook never arrives (e.g.
 * network error, provider outage, or the user closing the tab without paying).
 *
 * Provider-specific timeouts:
 *   - STRIPE: 24 h — Stripe Checkout sessions are valid for 24 h and Stripe
 *     delivers webhooks reliably. The poller is a last-resort fallback only.
 *     We also skip polling while the session is still REQUIRES_ACTION (customer
 *     hasn't submitted their card yet) to avoid the 15-min forced-FAILED that
 *     was prematurely marking live sessions as terminal.
 *   - VPS / NAPS / others: 15 min — short-lived provider sessions.
 */

import { getAdapter } from "../adapters/registry";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

const POLL_INTERVAL_MS = 30_000; // 30 s between polls
const MAX_DURATION_MS_DEFAULT = 900_000; // 15 min  — VPS / NAPS
const MAX_DURATION_MS_STRIPE = 86_400_000; // 24 h    — Stripe Checkout

/** Return the appropriate timeout for the given provider (ms). */
function maxDurationFor(provider: string): number {
  return provider.toUpperCase() === "STRIPE" ? MAX_DURATION_MS_STRIPE : MAX_DURATION_MS_DEFAULT;
}

export const paymentPoller = inngest.createFunction(
  {
    id: "payment-poller",
    name: "Payment Status Poller",
    triggers: [{ event: "payment/poll-status" }],
  },
  async ({ event, step }) => {
    const { intentId, provider, tenantId } = event.data as {
      intentId: string;
      provider: string;
      tenantId: string;
    };

    const started = Date.now();
    const maxDuration = maxDurationFor(provider);
    const isStripe = provider.toUpperCase() === "STRIPE";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // ── Wait before next poll (step.sleep is durable) ──────────────────────
      await step.sleep("poll-delay", POLL_INTERVAL_MS);

      // ── Fetch current intent state ─────────────────────────────────────────
      const intent = await step.run("fetch-intent", async () =>
        prisma.paymentIntent.findUnique({ where: { id: intentId } }),
      );

      if (!intent) break; // deleted – nothing to do

      // Already in a terminal state (webhook arrived) – stop polling
      const terminal = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"];
      if (terminal.includes(intent.status)) break;

      // ── Pre-auth (manual capture) guard ────────────────────────────────────
      // Pre-auth intents are authorized + put on hold and await an explicit
      // merchant capture (POST /payment-intents/:id/capture) or void (/cancel).
      // "Authorized, awaiting capture" is a legitimate long-lived state — NOT an
      // abandoned checkout — so the poller must never force-fail it. The
      // payment_intent.amount_capturable_updated webhook (Stripe) / AUTHORISED
      // poll (VPS) drives the REQUIRES_ACTION transition; the capture route
      // resolves it.
      const isPreauth = (intent.metadata as { isPreauth?: boolean } | null)?.isPreauth === true;
      if (isPreauth) {
        continue;
      }

      // ── Timeout: mark the intent as FAILED ────────────────────────────────
      if (Date.now() - started >= maxDuration) {
        await step.run("mark-timeout-failed", async () =>
          prisma.paymentIntent.update({
            where: { id: intentId },
            data: { status: "FAILED" },
          }),
        );
        break;
      }

      // ── Stripe: skip active-session polls, rely on webhooks ───────────────
      // While the Stripe Checkout session is in REQUIRES_ACTION the customer
      // is still on the payment page. Querying the provider at this point
      // would return `requires_payment_method` → REQUIRES_ACTION (no change)
      // and, more importantly, the previous 15-min hard timeout was wrongly
      // force-failing live sessions before the customer could enter their card.
      // We let the Stripe webhook processor handle all Stripe status transitions;
      // the poller only intervenes if a terminal webhook never arrives (after 24 h).
      if (isStripe && intent.status === "REQUIRES_ACTION") {
        continue;
      }

      // ── Query provider for the current status ─────────────────────────────
      const queryResult = await step.run("query-provider", async () => {
        const config = await prisma.providerConfig.findFirst({
          where: { tenantId, provider: provider as any, status: "CONNECTED" },
        });
        if (!config) return null;

        try {
          const adapter = getAdapter(provider as any, config.encryptedCredentials);
          return adapter.queryTransactionStatus(intent.providerRef ?? "");
        } catch {
          return null;
        }
      });

      if (!queryResult) continue;

      const { status: newStatus } = queryResult as { status: string };

      if (newStatus && newStatus !== intent.status) {
        await step.run("update-status", async () =>
          prisma.paymentIntent.update({
            where: { id: intentId },
            data: { status: newStatus as any },
          }),
        );

        // If we just transitioned to a terminal state, fire the notification job
        if (["SUCCEEDED", "REFUNDED"].includes(newStatus)) {
          await step.sendEvent("send-notification", {
            name: "payment/notify",
            data: {
              intentId,
              tenantId,
              status: newStatus,
              webhookEventId: null,
            },
          });
          break;
        }

        if (["FAILED", "CANCELED"].includes(newStatus)) break;
      }
    }

    return { intentId, done: true };
  },
);
