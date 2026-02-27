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
import { Decimal } from '@prisma/client/runtime/library';
import { inngest }          from '../lib/inngest';
import { prisma }           from '../lib/prisma';
import { decrypt }          from '../lib/encryption';
import { getAdapter }       from '../adapters/registry';
import { VpsAdapter }       from '../adapters/vps.adapter';
import { maskObject }       from '../lib/mask';
import {
  computeNextBillingDate,
  billingIdempotencyKey,
  notifySubscriptionEvent,
} from '../lib/billing';
import { BillingInterval }  from '@prisma/client';

interface RenewalDuePayload {
  subscriptionId:   string;
  tenantId:         string;
  customerId:       string;
  amount:           number;  // in MAD × 100 == centimes
  currency:         string;
  intervalType:     BillingInterval;
  intervalValue:    number;
  chargeId:         string;
  idempotencyId:    string;
  attemptNumber:    number;
}

/** Attempt a single VPS renewal charge. Returns success flag + raw response. */
async function attemptCharge(
  subscriptionId: string,
  tenantId: string,
  chargeId: string,
  idempotencyId: string,
  amountCentimes: number,
  currency: string,
  attemptNumber: number,
): Promise<{ success: boolean; vpsTransactionId?: string; errorMessage?: string; raw: Record<string, unknown> }> {
  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });
  if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED') {
    return { success: false, errorMessage: `Subscription is ${subscription.status}`, raw: {} };
  }

  const config = await prisma.providerConfig.findFirst({
    where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
  });
  if (!config) {
    return { success: false, errorMessage: 'VPS provider config not found or disconnected', raw: {} };
  }

  const adapter  = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
  const profileId = decrypt(subscription.encryptedStoredProfileId);

  const result = await adapter.chargeRenewal(
    profileId,
    amountCentimes,
    currency,
    chargeId,
    idempotencyId,
  );

  // Upsert a BillingEvent for this attempt
  await prisma.billingEvent.upsert({
    where: { id: `${subscriptionId}-${idempotencyId}-${attemptNumber}`.slice(0, 25) },
    create: {
      id:             `${subscriptionId}-${idempotencyId}-${attemptNumber}`.slice(0, 25),
      subscriptionId,
      chargeId,
      vpsTransactionId: result.providerTransactionId,
      amount:         new Decimal(amountCentimes / 100),
      currency,
      status:         result.success ? 'CHARGED' : 'DECLINED',
      attemptNumber,
      processedAt:    new Date(),
      errorMessage:   result.success ? null : (result.rawResponse['message'] as string ?? 'Charge declined'),
    },
    update: {
      vpsTransactionId: result.providerTransactionId,
      status:           result.success ? 'CHARGED' : 'DECLINED',
      processedAt:      new Date(),
      errorMessage:     result.success ? null : (result.rawResponse['message'] as string ?? 'Charge declined'),
    },
  }).catch(() => {
    // If ID collision from cuid, create with generated id
    return prisma.billingEvent.create({
      data: {
        subscriptionId,
        chargeId,
        vpsTransactionId: result.providerTransactionId,
        amount:           new Decimal(amountCentimes / 100),
        currency,
        status:           result.success ? 'CHARGED' : 'DECLINED',
        attemptNumber,
        processedAt:      new Date(),
        errorMessage:     result.success ? null : (result.rawResponse['message'] as string ?? 'Charge declined'),
      },
    });
  });

  return {
    success:          result.success,
    vpsTransactionId: result.providerTransactionId,
    errorMessage:     result.success ? undefined : (result.rawResponse['message'] as string ?? 'Charge declined'),
    raw:              maskObject(result.rawResponse) as Record<string, unknown>,
  };
}

export const billingRenewal = inngest.createFunction(
  {
    id:      'billing-renewal',
    name:    'Billing Renewal',
    retries: 0, // We manage retries explicitly via step.sleep
  },
  { event: 'billing/renewal.due' },
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
    const subscription = await step.run('validate-subscription', async () => {
      return prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });
    });

    if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED' || subscription.status === 'PAUSED') {
      return { skipped: true, reason: `Subscription is ${subscription.status}` };
    }

    // Store the Inngest runId so pause/cancel can target it
    await step.run('store-run-id', async () => {
      return prisma.subscription.update({
        where: { id: subscriptionId },
        data:  { inngestRunId: runId },
      });
    });

    // ── Step 2: First charge attempt ──────────────────────────────────────────
    const attempt1 = await step.run('charge-attempt-1', async () => {
      return attemptCharge(subscriptionId, tenantId, chargeId, idempotencyId, amount, currency, 1);
    });

    if (attempt1.success) {
      return await step.run('advance-cycle-after-1', async () => {
        return advanceBillingCycle(subscriptionId, tenantId, customerId, amount, currency, intervalType, intervalValue);
      });
    }

    // ── Step 3a: First failure → mark PAST_DUE ───────────────────────────────
    await step.run('mark-past-due', async () => {
      return prisma.subscription.update({
        where: { id: subscriptionId },
        data:  { status: 'PAST_DUE', retryCount: 1 },
      });
    });

    await step.run('notify-failure-1', async () => {
      return notifySubscriptionEvent({
        event:          'payment_failed',
        tenantId,
        customerId,
        subscriptionId,
        amount,
        currency,
        attemptNumber:  1,
      });
    });

    // ── Step 3b: Retry after 1 day ────────────────────────────────────────────
    await step.sleep('wait-before-retry-2', '1d');

    // Check if subscription was cancelled during the sleep
    const preRetry2 = await step.run('check-before-retry-2', async () =>
      prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true } }),
    );
    if (preRetry2?.status === 'CANCELLED' || preRetry2?.status === 'PAUSED') {
      return { skipped: true, reason: `Subscription ${preRetry2.status} before retry 2` };
    }

    const attempt2 = await step.run('charge-attempt-2', async () => {
      return attemptCharge(subscriptionId, tenantId, `${chargeId}-r2`, `${idempotencyId}-r2`, amount, currency, 2);
    });

    if (attempt2.success) {
      return await step.run('advance-cycle-after-2', async () => {
        return advanceBillingCycle(subscriptionId, tenantId, customerId, amount, currency, intervalType, intervalValue);
      });
    }

    await step.run('notify-failure-2', async () => {
      return notifySubscriptionEvent({
        event:          'payment_failed',
        tenantId,
        customerId,
        subscriptionId,
        amount,
        currency,
        attemptNumber:  2,
      });
    });

    // ── Step 3c: Retry after 2 more days ──────────────────────────────────────
    await step.sleep('wait-before-retry-3', '2d');

    const preRetry3 = await step.run('check-before-retry-3', async () =>
      prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true } }),
    );
    if (preRetry3?.status === 'CANCELLED' || preRetry3?.status === 'PAUSED') {
      return { skipped: true, reason: `Subscription ${preRetry3.status} before retry 3` };
    }

    const attempt3 = await step.run('charge-attempt-3', async () => {
      return attemptCharge(subscriptionId, tenantId, `${chargeId}-r3`, `${idempotencyId}-r3`, amount, currency, 3);
    });

    if (attempt3.success) {
      return await step.run('advance-cycle-after-3', async () => {
        return advanceBillingCycle(subscriptionId, tenantId, customerId, amount, currency, intervalType, intervalValue);
      });
    }

    await step.run('notify-failure-3', async () => {
      return notifySubscriptionEvent({
        event:          'payment_failed',
        tenantId,
        customerId,
        subscriptionId,
        amount,
        currency,
        attemptNumber:  3,
      });
    });

    // ── Step 3d: Final retry after 4 more days ────────────────────────────────
    await step.sleep('wait-before-retry-4', '4d');

    const preRetry4 = await step.run('check-before-retry-4', async () =>
      prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true } }),
    );
    if (preRetry4?.status === 'CANCELLED' || preRetry4?.status === 'PAUSED') {
      return { skipped: true, reason: `Subscription ${preRetry4.status} before retry 4` };
    }

    const attempt4 = await step.run('charge-attempt-4', async () => {
      return attemptCharge(subscriptionId, tenantId, `${chargeId}-r4`, `${idempotencyId}-r4`, amount, currency, 4);
    });

    if (attempt4.success) {
      return await step.run('advance-cycle-after-4', async () => {
        return advanceBillingCycle(subscriptionId, tenantId, customerId, amount, currency, intervalType, intervalValue);
      });
    }

    // ── Step 4: Max retries exhausted → cancel subscription ───────────────────
    await step.run('cancel-subscription', async () => {
      return prisma.subscription.update({
        where: { id: subscriptionId },
        data:  { status: 'CANCELLED', inngestRunId: null },
      });
    });

    await step.run('notify-cancelled', async () => {
      return notifySubscriptionEvent({
        event:          'subscription_cancelled',
        tenantId,
        customerId,
        subscriptionId,
        amount,
        currency,
      });
    });

    return { cancelled: true, subscriptionId, reason: 'max_retries_exhausted' };
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
  const now         = new Date();
  const nextBilling = computeNextBillingDate(now, intervalType, intervalValue);

  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status:             'ACTIVE',
      retryCount:         0,
      currentPeriodStart: now,
      currentPeriodEnd:   nextBilling,
      nextBillingDate:    nextBilling,
    },
  });

  // Fire the next renewal event (will be picked up by daily sweep OR directly)
  const nextKey = billingIdempotencyKey(subscriptionId, nextBilling);
  await inngest.send({
    id:   nextKey,
    name: 'billing/renewal.due',
    data: {
      subscriptionId,
      tenantId,
      customerId,
      amount,
      currency,
      intervalType,
      intervalValue,
      chargeId:      `renewal-${nextKey}`,
      idempotencyId: nextKey,
      attemptNumber: 1,
    },
  });

  await notifySubscriptionEvent({
    event: 'payment_success',
    tenantId,
    customerId,
    subscriptionId,
    amount,
    currency,
  });

  return { success: true, nextBillingDate: nextBilling };
}
