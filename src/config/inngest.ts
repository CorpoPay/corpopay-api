import { serve } from "inngest/express";
import { billingDailySweep } from "../jobs/billingDailySweep.inngest";
import { billingRenewal } from "../jobs/billingRenewal.inngest";
import { billingSimulation } from "../jobs/billingSimulation.inngest";
import { installmentCharge } from "../jobs/installmentCharge.inngest";
import { installmentSimulation } from "../jobs/installmentSimulation.inngest";
import { notifications } from "../jobs/notifications.inngest";
import { paymentPoller } from "../jobs/paymentPoller.inngest";
import { stripeWebhookProcessor } from "../jobs/stripeWebhookProcessor.inngest";
import { onSubscriptionCreated } from "../jobs/subscriptionActivated.inngest";
import { webhookProcessor } from "../jobs/webhookProcessor.inngest";
import { inngest } from "../lib/inngest";

/**
 * Inngest job handler (POST /api/inngest).
 *
 * Receives events from Inngest Cloud (or the local Dev Server on port 8288).
 * Keeping the function list here (rather than inline in app.ts) means adding a
 * background job is a single edit in one place.
 */
export const inngestHandler = serve({
  client: inngest,
  functions: [
    webhookProcessor,
    stripeWebhookProcessor,
    paymentPoller,
    notifications,
    onSubscriptionCreated,
    billingRenewal,
    billingDailySweep,
    billingSimulation,
    installmentCharge,
    installmentSimulation,
  ],
});
