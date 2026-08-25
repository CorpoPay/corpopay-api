/**
 * Job: billing-daily-sweep
 *
 * Cron: midnight UTC every day.
 *
 * Finds all ACTIVE and PAST_DUE subscriptions whose nextBillingDate is due
 * (<=  now), then dispatches a billing/renewal.due event for each one.
 *
 * Inngest's built-in event deduplication (event ID == idempotencyId) ensures
 * that even if the cron fires twice, only one workflow runs per billing period.
 */

import { billingIdempotencyKey } from "../lib/billing";
import { inngest } from "../lib/inngest";
import { madToCentimes } from "../lib/money";
import { prisma } from "../lib/prisma";

export const billingDailySweep = inngest.createFunction(
  {
    id: "billing-daily-sweep",
    name: "Billing Daily Sweep",
  },
  { cron: "0 0 * * *" }, // midnight UTC daily
  async ({ step }) => {
    // ── Step 1: Fetch all subscriptions due for billing ───────────────────────
    const due = await step.run("find-due-subscriptions", async () => {
      const now = new Date();
      return prisma.subscription.findMany({
        where: {
          status: { in: ["ACTIVE", "PAST_DUE"] },
          nextBillingDate: { lte: now },
        },
        select: {
          id: true,
          tenantId: true,
          customerId: true,
          amount: true,
          currency: true,
          intervalType: true,
          intervalValue: true,
          nextBillingDate: true,
        },
      });
    });

    if (due.length === 0) {
      return { dispatched: 0 };
    }

    // ── Step 2: Dispatch renewal events for each due subscription ─────────────
    await step.run("dispatch-renewals", async () => {
      const events = due.map((sub) => {
        const date = new Date(sub.nextBillingDate ?? new Date());
        const idemKey = billingIdempotencyKey(sub.id, date);

        return {
          id: idemKey, // Inngest deduplication — safe to run daily sweep multiple times
          name: "billing/renewal.due" as const,
          data: {
            subscriptionId: sub.id,
            tenantId: sub.tenantId,
            customerId: sub.customerId,
            amount: madToCentimes(sub.amount), // MAD → centimes
            currency: sub.currency,
            intervalType: sub.intervalType,
            intervalValue: sub.intervalValue,
            chargeId: `renewal-${idemKey}`,
            idempotencyId: idemKey,
            attemptNumber: 1,
          },
        };
      });

      await inngest.send(events);
      return { count: events.length };
    });

    return { dispatched: due.length };
  },
);
