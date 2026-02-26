/**
 * Job: webhook/process
 *
 * Triggered by the /webhooks/:provider route instantly after receiving a provider
 * notification.  Owns the full webhook processing pipeline that previously ran
 * synchronously inside Express – signature verification, intent status update,
 * providerTransaction upsert, paymentLink mark-PAID, and WebhookEvent storage.
 *
 * This moves the slow DB work off the HTTP hot-path so providers get an immediate
 * 200 and never time-out waiting for us.
 */
import { Provider } from '@prisma/client';
import { inngest }   from '../lib/inngest';
import { prisma }    from '../lib/prisma';
import { getAdapter } from '../adapters/registry';
import { maskObject } from '../lib/mask';

export const webhookProcessor = inngest.createFunction(
  {
    id:      'webhook-processor',
    name:    'Webhook Processor',
    // Inngest deduplicates events with the same id within a 24-h window.
    // We pass the provider-supplied idempotency key as the event id in send().
  },
  { event: 'webhook/process' },
  async ({ event, step }) => {
    const {
      provider,
      payloadJson,
      rawBodyBase64,
      headers,
      idempotencyKey,
    } = event.data as {
      provider:       Provider;
      payloadJson:    Record<string, unknown>;
      rawBodyBase64:  string;
      headers:        Record<string, string>;
      idempotencyKey: string | null;
    };

    const rawBody = Buffer.from(rawBodyBase64, 'base64');
    const payload = payloadJson;

    // ── Step 1: Resolve correlating PaymentIntent ────────────────────────────
    const intent = await step.run('find-intent', async () => {
      const providerRef =
        (payload['orderId']    as string | undefined) ??
        (payload['OrderID']    as string | undefined) ??
        (payload['paymentId']  as string | undefined) ??
        null;

      if (!providerRef) return null;

      return prisma.paymentIntent.findFirst({
        where:   { providerRef, provider },
        include: { paymentLink: { select: { tenantId: true } } },
      });
    });

    const tenantId = intent?.tenantId ?? null;

    // ── Step 2: Verify signature ─────────────────────────────────────────────
    const signatureVerified = await step.run('verify-signature', async () => {
      if (!tenantId) return false;
      const config = await prisma.providerConfig.findFirst({
        where: { tenantId, provider },
      });
      if (!config) return false;
      try {
        const adapter = getAdapter(provider, config.encryptedCredentials);
        return adapter.verifyWebhookSignature(rawBody, headers);
      } catch {
        return false;
      }
    });

    // ── Step 3: Map status + update intent ───────────────────────────────────
    const providerStatus =
      (payload['Status']            as string | undefined) ??
      (payload['status']            as string | undefined) ??
      (payload['transactionStatus'] as string | undefined);

    let mappedStatus: string | null   = null;
    let processingError: string | null = null;
    let processed = false;

    if (providerStatus && intent && tenantId) {
      const result = await step.run('update-intent-status', async () => {
        const config = await prisma.providerConfig.findFirst({ where: { tenantId, provider } });
        if (!config) return { mappedStatus: null, processingError: 'No provider config', processed: false };

        try {
          const adapter        = getAdapter(provider, config.encryptedCredentials);
          const internalStatus = adapter.mapStatusToInternal(providerStatus);

          const providerTransactionId =
            (payload['transactionId']  as string | undefined) ??
            (payload['TransactionID']  as string | undefined) ??
            null;

          const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED'];
          if (!terminal.includes(intent.status)) {
            await prisma.paymentIntent.update({
              where: { id: intent.id },
              data:  { status: internalStatus },
            });
          }

          if (providerTransactionId) {
            const existing = await prisma.providerTransaction.findFirst({
              where: { paymentIntentId: intent.id },
            });
            if (existing) {
              await prisma.providerTransaction.update({
                where: { id: existing.id },
                data:  { providerTransactionId, rawResponse: maskObject(payload) as any },
              });
            }
          }

          if (internalStatus === 'SUCCEEDED' && intent.paymentLinkId) {
            await prisma.paymentLink.update({
              where: { id: intent.paymentLinkId },
              data:  { status: 'PAID' },
            });
          }

          return { mappedStatus: internalStatus, processingError: null, processed: true };
        } catch (err: unknown) {
          return { mappedStatus: null, processingError: (err as Error).message, processed: false };
        }
      });

      mappedStatus    = result.mappedStatus;
      processingError = result.processingError;
      processed       = result.processed;
    }

    // ── Step 4: Store WebhookEvent record ────────────────────────────────────
    const webhookEvent = await step.run('store-webhook-event', async () => {
      return prisma.webhookEvent.create({
        data: {
          provider,
          tenantId,
          paymentIntentId:  intent?.id ?? null,
          rawPayload:       maskObject(payload) as any,
          headers:          maskObject(headers) as any,
          signatureVerified,
          processed,
          processingError,
          mappedStatus,
          idempotencyKey,
        },
      });
    });

    // ── Step 5: Fire notification job when a terminal state is reached ───────
    if (processed && (mappedStatus === 'SUCCEEDED' || mappedStatus === 'REFUNDED')) {
      await step.sendEvent('send-payment-notification', {
        name: 'payment/notify',
        data: {
          intentId:      intent!.id,
          tenantId:      tenantId!,
          status:        mappedStatus,
          webhookEventId: webhookEvent.id,
        },
      });
    }

    return { webhookEventId: webhookEvent.id, processed, mappedStatus };
  },
);
