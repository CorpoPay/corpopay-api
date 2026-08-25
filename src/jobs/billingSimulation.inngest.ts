/**
 * Job: billing/renewal.simulation
 *
 * A super-admin-only simulation of the full recurring billing lifecycle.
 * Identical logic to billingRenewal, but:
 *   - Triggered by `billing/renewal.simulation` events (never by the daily sweep)
 *   - Retry delay is configurable in SECONDS rather than days, so the full
 *     dunning path can be observed in real time.
 *   - The subscription being charged is always a simulation record
 *     (customerId starts with "__SIM_") and can be cleaned up by the admin.
 *
 * Charge outcome against VPS sandbox: the fake storedPaymentProfileId will be
 * declined by Payzone, which is the correct behaviour for testing the dunning
 * path. If you want to test a success path, replace the encrypted profile in
 * simulation/start with a real sandbox profile obtained from a prior checkout.
 */

import type { BillingInterval } from "@/generated/prisma/client";
import { computeNextBillingDate, notifySubscriptionEvent } from "../lib/billing";
import { chargeSubscription, runDunningLadder } from "../lib/dunning";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

interface SimulationPayload {
  subscriptionId: string;
  tenantId: string;
  customerId: string;
  amount: number; // centimes
  currency: string;
  intervalType: BillingInterval;
  intervalValue: number;
  chargeId: string;
  idempotencyId: string;
  attemptNumber: number;
  /** Delay between dunning retries expressed as an Inngest sleep string, e.g. "30s", "2m" */
  retryDelay1: string; // after first failure  (default: '30s')
  retryDelay2: string; // after second failure (default: '1m')
  retryDelay3: string; // after third failure  (default: '2m')
}

// ─── Inngest function ──────────────────────────────────────────────────────────

export const billingSimulation = inngest.createFunction(
  {
    id: "billing-simulation",
    name: "Billing Simulation (Admin)",
    retries: 0,
    triggers: [{ event: "billing/renewal.simulation" }],
  },
  async ({ event, step }) => {
    const data = event.data as SimulationPayload;
    const {
      subscriptionId,
      tenantId,
      customerId,
      amount,
      currency,
      intervalType,
      intervalValue,
      chargeId,
      idempotencyId,
      retryDelay1 = "30s",
      retryDelay2 = "1m",
      retryDelay3 = "2m",
    } = data;

    // ── 1. Validate ────────────────────────────────────────────────────────────
    const sub = await step.run("validate-simulation-sub", () =>
      prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
    );
    if (sub.status === "CANCELLED" || sub.status === "EXPIRED") {
      return { skipped: true, reason: `Subscription is ${sub.status}` };
    }

    return runDunningLadder({
      step,
      maxAttempts: 4,
      delays: [retryDelay1, retryDelay2, retryDelay3],
      stepNames: {
        attempt: (n) => `sim-charge-${n}`,
        wait: (n) => `sim-wait-retry-${n}`,
        check: (n) => `sim-check-before-${n}`,
      },
      attempt: (n) =>
        chargeSubscription({
          subscriptionId,
          tenantId,
          chargeId: n === 1 ? chargeId : `${chargeId}-r${n}`,
          idempotencyId: n === 1 ? idempotencyId : `${idempotencyId}-r${n}`,
          amountCentimes: amount,
          currency,
          attemptNumber: n,
          recordMode: "create",
        }),
      shouldStop: async () => {
        const s = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          select: { status: true },
        });
        if (s?.status === "CANCELLED") {
          return { stop: true, reason: "Cancelled before retry" };
        }
        return { stop: false, reason: "" };
      },
      onSuccess: (step, n) =>
        step.run(`sim-advance-${n}`, async () => {
          const next = computeNextBillingDate(new Date(), intervalType, intervalValue);
          await prisma.subscription.update({
            where: { id: subscriptionId },
            data: { status: "ACTIVE", nextBillingDate: next, retryCount: 0 },
          });
          return { success: true, nextBillingDate: next };
        }),
      onFailure: async (step, n) => {
        if (n === 1) {
          await step.run("sim-past-due", () =>
            prisma.subscription.update({
              where: { id: subscriptionId },
              data: { status: "PAST_DUE", retryCount: 1 },
            }),
          );
        }
        await step.run(`sim-notify-fail-${n}`, () =>
          notifySubscriptionEvent({
            event: "payment_failed",
            tenantId,
            customerId,
            subscriptionId,
            amount,
            currency,
            attemptNumber: n,
          }),
        );
      },
      onExhausted: async (step) => {
        await step.run("sim-cancel", async () => {
          await prisma.subscription.update({
            where: { id: subscriptionId },
            data: { status: "CANCELLED", retryCount: 4 },
          });
          await notifySubscriptionEvent({
            event: "subscription_cancelled",
            tenantId,
            customerId,
            subscriptionId,
          });
        });
        return {
          success: false,
          cancelled: true,
          reason: "Max retries exhausted — subscription cancelled",
        };
      },
    });
  },
);
