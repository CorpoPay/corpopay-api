/**
 * Job: billing/subscription.activated
 *
 * Fired after an initial VPS payment is confirmed (CHARGED) and a Subscription
 * row has been created in PENDING status.  This function:
 *  1. Activates the subscription (sets status=ACTIVE, period dates, nextBillingDate).
 *  2. Sleeps through any trial period.
 *  3. Fires the first billing/renewal.due event to kick off charging.
 */
import { BillingInterval } from '@prisma/client';
import { inngest }  from '../lib/inngest';
import { prisma }   from '../lib/prisma';
import { encrypt }  from '../lib/encryption';
import { computeNextBillingDate, billingIdempotencyKey, notifySubscriptionEvent } from '../lib/billing';

interface SubscriptionActivatedPayload {
  subscriptionId:          string;
  storedPaymentProfileId:  string; // plain-text — we encrypt it here
  tenantId:                string;
  customerId:              string;
  amount:                  number; // MAD decimal × 100 == centimes
  currency:                string;
  intervalType:            BillingInterval;
  intervalValue:           number;
  trialDays?:              number;
}

export const onSubscriptionCreated = inngest.createFunction(
  {
    id:   'on-subscription-created',
    name: 'On Subscription Created',
  },
  { event: 'billing/subscription.activated' },
  async ({ event, step }) => {
    const data = event.data as SubscriptionActivatedPayload;

    // ── Step 1: Activate subscription ────────────────────────────────────────
    const subscription = await step.run('activate-subscription', async () => {
      const now           = new Date();
      const nextBilling   = computeNextBillingDate(now, data.intervalType, data.intervalValue);
      const periodEnd     = new Date(nextBilling);
      const encryptedProfileId = encrypt(data.storedPaymentProfileId);

      return prisma.subscription.update({
        where: { id: data.subscriptionId },
        data: {
          status:                    'ACTIVE',
          encryptedStoredProfileId:  encryptedProfileId,
          currentPeriodStart:        now,
          currentPeriodEnd:          periodEnd,
          nextBillingDate:           nextBilling,
          updatedAt:                 now,
        },
      });
    });

    // ── Step 2: Notify customer ───────────────────────────────────────────────
    await step.run('notify-subscription-created', async () => {
      await notifySubscriptionEvent({
        event:          'subscription_created',
        tenantId:       data.tenantId,
        customerId:     data.customerId,
        subscriptionId: data.subscriptionId,
        amount:         data.amount,
        currency:       data.currency,
      });
    });

    // ── Step 3: Sleep through trial (if applicable) ───────────────────────────
    if (data.trialDays && data.trialDays > 0) {
      await step.sleep('wait-trial-period', `${data.trialDays}d`);
    }

    // ── Step 4: Trigger first renewal ─────────────────────────────────────────
    const now    = new Date();
    const dueKey = billingIdempotencyKey(data.subscriptionId, new Date(subscription.nextBillingDate ?? now));

    await step.sendEvent('trigger-first-renewal', {
      id:   dueKey, // Inngest deduplication key
      name: 'billing/renewal.due',
      data: {
        subscriptionId:         data.subscriptionId,
        tenantId:               data.tenantId,
        customerId:             data.customerId,
        amount:                 data.amount,
        currency:               data.currency,
        intervalType:           data.intervalType,
        intervalValue:          data.intervalValue,
        chargeId:               `renewal-${dueKey}`,
        idempotencyId:          dueKey,
        attemptNumber:          1,
      },
    });

    return { subscriptionId: data.subscriptionId, status: 'ACTIVE' };
  },
);
