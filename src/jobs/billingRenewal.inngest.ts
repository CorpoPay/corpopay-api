/**
 * Job: billing/renewal.due
 *
 * Core recurring billing workflow.  Triggered by:
 *   - onSubscriptionCreated  (first billing cycle)
 *   - billingDailySweep cron (subsequent cycles)
 *
 * Handles the full charge + dunning lifecycle:
 *   1. Validate subscription is still chargeable.
 *   2. Charge via VPS RENEWAL API.
 *   3a. On success → advance billing cycle, notify customer.
 *   3b. On failure → enter dunning (retry at +1d, +2d, +4d), then cancel.
 *
 * Event deduplication: the Inngest event ID is set to the idempotencyId
 * so only one workflow fires per subscription per billing period.
 */

import type { BillingInterval } from "@/generated/prisma/client";
import {
  billingIdempotencyKey,
  computeNextBillingDate,
  notifySubscriptionEvent,
} from "../lib/billing";
import { chargeSubscription, runDunningLadder } from "../lib/dunning";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

interface RenewalDuePayload {
  subscriptionId: string;
  tenantId: string;
  customerId: string;
  amount: number; // in MAD × 100 == centimes
  currency: string;
  intervalType: BillingInterval;
  intervalValue: number;
  chargeId: string;
  idempotencyId: string;
  attemptNumber: number;
}

export const billingRenewal = inngest.createFunction(
  {
    id: "billing-renewal",
    name: "Billing Renewal",
    retries: 0, // We manage retries explicitly via step.sleep
  },
  { event: "billing/renewal.due" },
  async ({ event, step, runId }) => {
    const data = event.data as RenewalDuePayload;
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
    } = data;

    // ── Step 1: Pre-charge validation ─────────────────────────────────────────
    const subscription = await step.run("validate-subscription", async () => {
      return prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });
    });

    if (
      subscription.status === "CANCELLED" ||
      subscription.status === "EXPIRED" ||
      subscription.status === "PAUSED"
    ) {
      return { skipped: true, reason: `Subscription is ${subscription.status}` };
    }

    // Store the Inngest runId so pause/cancel can target it
    await step.run("store-run-id", async () => {
      return prisma.subscription.update({
        where: { id: subscriptionId },
        data: { inngestRunId: runId },
      });
    });

    // ── Step 2: Charge + dunning ladder ───────────────────────────────────────
    return runDunningLadder({
      step,
      maxAttempts: 4,
      delays: ["1d", "2d", "4d"],
      stepNames: {
        attempt: (n) => `charge-attempt-${n}`,
        wait: (n) => `wait-before-retry-${n}`,
        check: (n) => `check-before-retry-${n}`,
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
          recordMode: "upsert",
        }),
      shouldStop: async (n) => {
        const s = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          select: { status: true },
        });
        if (s?.status === "CANCELLED" || s?.status === "PAUSED") {
          return { stop: true, reason: `Subscription ${s.status} before retry ${n}` };
        }
        return { stop: false, reason: "" };
      },
      onSuccess: (step, n) =>
        step.run(`advance-cycle-after-${n}`, async () =>
          advanceBillingCycle(
            subscriptionId,
            tenantId,
            customerId,
            amount,
            currency,
            intervalType,
            intervalValue,
          ),
        ),
      onFailure: async (step, n) => {
        if (n === 1) {
          await step.run("mark-past-due", async () =>
            prisma.subscription.update({
              where: { id: subscriptionId },
              data: { status: "PAST_DUE", retryCount: 1 },
            }),
          );
        }
        await step.run(`notify-failure-${n}`, async () =>
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
        await step.run("cancel-subscription", async () =>
          prisma.subscription.update({
            where: { id: subscriptionId },
            data: { status: "CANCELLED", inngestRunId: null },
          }),
        );
        await step.run("notify-cancelled", async () =>
          notifySubscriptionEvent({
            event: "subscription_cancelled",
            tenantId,
            customerId,
            subscriptionId,
            amount,
            currency,
          }),
        );
        return { cancelled: true, subscriptionId, reason: "max_retries_exhausted" };
      },
    });
  },
);

/** Advance the billing cycle after a successful charge. */
async function advanceBillingCycle(
  subscriptionId: string,
  tenantId: string,
  customerId: string,
  amount: number,
  currency: string,
  intervalType: BillingInterval,
  intervalValue: number,
) {
  const now = new Date();
  const nextBilling = computeNextBillingDate(now, intervalType, intervalValue);

  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: "ACTIVE",
      retryCount: 0,
      currentPeriodStart: now,
      currentPeriodEnd: nextBilling,
      nextBillingDate: nextBilling,
    },
  });

  // Fire the next renewal event (will be picked up by daily sweep OR directly)
  const nextKey = billingIdempotencyKey(subscriptionId, nextBilling);
  await inngest.send({
    id: nextKey,
    name: "billing/renewal.due",
    data: {
      subscriptionId,
      tenantId,
      customerId,
      amount,
      currency,
      intervalType,
      intervalValue,
      chargeId: `renewal-${nextKey}`,
      idempotencyId: nextKey,
      attemptNumber: 1,
    },
  });

  await notifySubscriptionEvent({
    event: "payment_success",
    tenantId,
    customerId,
    subscriptionId,
    amount,
    currency,
  });

  return { success: true, nextBillingDate: nextBilling };
}
