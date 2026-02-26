/**
 * Job: payment/poll-status
 *
 * Triggered immediately after a PaymentIntent is created and the user is
 * redirected to the provider's payment page.  Polls the provider every 30 s
 * until the intent reaches a terminal state, or a 15-minute timeout elapses,
 * at which point the intent is marked FAILED.
 *
 * This lets CorpoPay self-heal when a provider webhook never arrives (e.g.
 * network error, provider outage, or the user closing the tab without paying).
 */
import { inngest }    from '../lib/inngest';
import { prisma }    from '../lib/prisma';
import { getAdapter } from '../adapters/registry';

const POLL_INTERVAL_MS = 30_000;  // 30 s
const MAX_DURATION_MS  = 900_000; // 15 min

export const paymentPoller = inngest.createFunction(
  { id: 'payment-poller', name: 'Payment Status Poller' },
  { event: 'payment/poll-status' },
  async ({ event, step }) => {
    const { intentId, provider, tenantId } = event.data as {
      intentId:  string;
      provider:  string;
      tenantId:  string;
    };

    const started = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // ── Wait before next poll (step.sleep is durable) ──────────────────────
      await step.sleep('poll-delay', POLL_INTERVAL_MS);

      // ── Fetch current intent state ─────────────────────────────────────────
      const intent = await step.run('fetch-intent', async () =>
        prisma.paymentIntent.findUnique({ where: { id: intentId } }),
      );

      if (!intent) break; // deleted – nothing to do

      // Already in a terminal state (webhook arrived) – stop polling
      const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED'];
      if (terminal.includes(intent.status)) break;

      // ── Timeout: mark the intent as FAILED ────────────────────────────────
      if (Date.now() - started >= MAX_DURATION_MS) {
        await step.run('mark-timeout-failed', async () =>
          prisma.paymentIntent.update({
            where: { id: intentId },
            data:  { status: 'FAILED' },
          }),
        );
        break;
      }

      // ── Query provider for the current status ─────────────────────────────
      const queryResult = await step.run('query-provider', async () => {
        const config = await prisma.providerConfig.findFirst({
          where: { tenantId, provider: provider as any, status: 'CONNECTED' },
        });
        if (!config) return null;

        try {
          const adapter = getAdapter(provider as any, config.encryptedCredentials);
          return adapter.queryTransactionStatus(intent.providerRef ?? '');
        } catch {
          return null;
        }
      });

      if (!queryResult) continue;

      const { status: newStatus } = queryResult as { status: string };

      if (newStatus && newStatus !== intent.status) {
        await step.run('update-status', async () =>
          prisma.paymentIntent.update({
            where: { id: intentId },
            data:  { status: newStatus as any },
          }),
        );

        // If we just transitioned to a terminal state, fire the notification job
        if (['SUCCEEDED', 'REFUNDED'].includes(newStatus)) {
          await step.sendEvent('send-notification', {
            name: 'payment/notify',
            data: {
              intentId,
              tenantId,
              status: newStatus,
              webhookEventId: null,
            },
          });
          break;
        }

        if (['FAILED', 'CANCELED'].includes(newStatus)) break;
      }
    }

    return { intentId, done: true };
  },
);
