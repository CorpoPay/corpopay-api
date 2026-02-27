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
import { Decimal }  from '@prisma/client/runtime/library';
import { inngest }          from '../lib/inngest';
import { prisma }           from '../lib/prisma';
import { decrypt }          from '../lib/encryption';
import { getAdapter }       from '../adapters/registry';
import { VpsAdapter }       from '../adapters/vps.adapter';
import { maskObject }       from '../lib/mask';
import { computeNextBillingDate, notifySubscriptionEvent } from '../lib/billing';
import { BillingInterval }  from '@prisma/client';

interface SimulationPayload {
  subscriptionId:     string;
  tenantId:           string;
  customerId:         string;
  amount:             number;   // centimes
  currency:           string;
  intervalType:       BillingInterval;
  intervalValue:      number;
  chargeId:           string;
  idempotencyId:      string;
  attemptNumber:      number;
  /** Delay between dunning retries expressed as an Inngest sleep string, e.g. "30s", "2m" */
  retryDelay1:        string;   // after first failure  (default: '30s')
  retryDelay2:        string;   // after second failure (default: '1m')
  retryDelay3:        string;   // after third failure  (default: '2m')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function simCharge(
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
    return { success: false, errorMessage: 'VPS provider config not found', raw: {} };
  }

  const adapter   = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
  const profileId = decrypt(subscription.encryptedStoredProfileId);

  const result = await adapter.chargeRenewal(profileId, amountCentimes, currency, chargeId, idempotencyId);

  // Record billing event
  await prisma.billingEvent.create({
    data: {
      subscriptionId,
      chargeId,
      vpsTransactionId: result.providerTransactionId,
      amount:           new Decimal(amountCentimes / 100),
      currency,
      status:           result.success ? 'CHARGED' : 'DECLINED',
      attemptNumber,
      processedAt:      new Date(),
      errorMessage:     result.success ? null : ((result.rawResponse['message'] as string) ?? 'Charge declined'),
    },
  });

  return {
    success:          result.success,
    vpsTransactionId: result.providerTransactionId,
    errorMessage:     result.success ? undefined : ((result.rawResponse['message'] as string) ?? 'Charge declined'),
    raw:              maskObject(result.rawResponse) as Record<string, unknown>,
  };
}

// ─── Inngest function ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const billingSimulation: any = inngest.createFunction(
  {
    id:      'billing-simulation',
    name:    'Billing Simulation (Admin)',
    retries: 0,
  },
  { event: 'billing/renewal.simulation' },
  async ({ event, step }) => {
    const data = event.data as SimulationPayload;
    const {
      subscriptionId, tenantId, customerId, amount, currency,
      intervalType, intervalValue, chargeId, idempotencyId,
      retryDelay1 = '30s', retryDelay2 = '1m', retryDelay3 = '2m',
    } = data;

    // ── 1. Validate ────────────────────────────────────────────────────────────
    const sub = await step.run('validate-simulation-sub', () =>
      prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
    );
    if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') {
      return { skipped: true, reason: `Subscription is ${sub.status}` };
    }

    // ── 2. First charge attempt ────────────────────────────────────────────────
    const attempt1 = await step.run('sim-charge-1', () =>
      simCharge(subscriptionId, tenantId, chargeId, idempotencyId, amount, currency, 1),
    );

    if (attempt1.success) {
      return await step.run('sim-advance-1', async () => {
        const next = computeNextBillingDate(new Date(), intervalType, intervalValue);
        await prisma.subscription.update({
          where: { id: subscriptionId },
          data:  { status: 'ACTIVE', nextBillingDate: next, retryCount: 0 },
        });
        return { success: true, nextBillingDate: next };
      });
    }

    // ── 3a. First failure → PAST_DUE ──────────────────────────────────────────
    await step.run('sim-past-due', () =>
      prisma.subscription.update({
        where: { id: subscriptionId },
        data:  { status: 'PAST_DUE', retryCount: 1 },
      }),
    );

    await step.run('sim-notify-fail-1', () =>
      notifySubscriptionEvent({ event: 'payment_failed', tenantId, customerId, subscriptionId, amount, currency, attemptNumber: 1 }),
    );

    // ── 3b. Retry 2 ────────────────────────────────────────────────────────────
    await step.sleep('sim-wait-retry-2', retryDelay1);

    const preRetry2 = await step.run('sim-check-before-2', () =>
      prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true } }),
    );
    if (preRetry2?.status === 'CANCELLED') return { skipped: true, reason: 'Cancelled before retry 2' };

    const attempt2 = await step.run('sim-charge-2', () =>
      simCharge(subscriptionId, tenantId, `${chargeId}-r2`, `${idempotencyId}-r2`, amount, currency, 2),
    );
    if (attempt2.success) {
      return await step.run('sim-advance-2', async () => {
        const next = computeNextBillingDate(new Date(), intervalType, intervalValue);
        await prisma.subscription.update({ where: { id: subscriptionId }, data: { status: 'ACTIVE', nextBillingDate: next, retryCount: 0 } });
        return { success: true, nextBillingDate: next };
      });
    }

    await step.run('sim-notify-fail-2', () =>
      notifySubscriptionEvent({ event: 'payment_failed', tenantId, customerId, subscriptionId, amount, currency, attemptNumber: 2 }),
    );

    // ── 3c. Retry 3 ────────────────────────────────────────────────────────────
    await step.sleep('sim-wait-retry-3', retryDelay2);

    const preRetry3 = await step.run('sim-check-before-3', () =>
      prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true } }),
    );
    if (preRetry3?.status === 'CANCELLED') return { skipped: true, reason: 'Cancelled before retry 3' };

    const attempt3 = await step.run('sim-charge-3', () =>
      simCharge(subscriptionId, tenantId, `${chargeId}-r3`, `${idempotencyId}-r3`, amount, currency, 3),
    );
    if (attempt3.success) {
      return await step.run('sim-advance-3', async () => {
        const next = computeNextBillingDate(new Date(), intervalType, intervalValue);
        await prisma.subscription.update({ where: { id: subscriptionId }, data: { status: 'ACTIVE', nextBillingDate: next, retryCount: 0 } });
        return { success: true, nextBillingDate: next };
      });
    }

    await step.run('sim-notify-fail-3', () =>
      notifySubscriptionEvent({ event: 'payment_failed', tenantId, customerId, subscriptionId, amount, currency, attemptNumber: 3 }),
    );

    // ── 3d. Retry 4 (final) ────────────────────────────────────────────────────
    await step.sleep('sim-wait-retry-4', retryDelay3);

    const preRetry4 = await step.run('sim-check-before-4', () =>
      prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true } }),
    );
    if (preRetry4?.status === 'CANCELLED') return { skipped: true, reason: 'Cancelled before retry 4' };

    const attempt4 = await step.run('sim-charge-4', () =>
      simCharge(subscriptionId, tenantId, `${chargeId}-r4`, `${idempotencyId}-r4`, amount, currency, 4),
    );
    if (attempt4.success) {
      return await step.run('sim-advance-4', async () => {
        const next = computeNextBillingDate(new Date(), intervalType, intervalValue);
        await prisma.subscription.update({ where: { id: subscriptionId }, data: { status: 'ACTIVE', nextBillingDate: next, retryCount: 0 } });
        return { success: true, nextBillingDate: next };
      });
    }

    // ── Final: cancel after exhausted retries ──────────────────────────────────
    await step.run('sim-cancel', async () => {
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data:  { status: 'CANCELLED', retryCount: 4 },
      });
      await notifySubscriptionEvent({ event: 'subscription_cancelled', tenantId, customerId, subscriptionId });
    });

    return { success: false, cancelled: true, reason: 'Max retries exhausted — subscription cancelled' };
  },
);
