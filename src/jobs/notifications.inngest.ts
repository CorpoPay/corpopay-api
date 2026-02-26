/**
 * Job: payment/notify
 *
 * Triggered when a PaymentIntent reaches SUCCEEDED or REFUNDED.
 * Fetches tenant notification preferences and calls the internal notification
 * service (email / SMS / WhatsApp) configured per tenant.
 *
 * Add your own email/SMS/WhatsApp adapters here – the job schema is kept
 * provider-agnostic so swapping providers is a one-file change.
 */
import { inngest } from '../lib/inngest';
import { prisma }  from '../lib/prisma';

export const notifications = inngest.createFunction(
  {
    id:      'payment-notifications',
    name:    'Payment Notifications',
    // Retry up to 3 times with exponential back-off if the notification
    // endpoint is temporarily unavailable.
    retries: 3,
  },
  { event: 'payment/notify' },
  async ({ event, step }) => {
    const { intentId, tenantId, status } = event.data as {
      intentId:       string;
      tenantId:       string;
      status:         string;
      webhookEventId: string | null;
    };

    // ── Fetch intent + associated payment link for context ───────────────────
    const intent = await step.run('fetch-intent', async () =>
      prisma.paymentIntent.findUnique({
        where:   { id: intentId },
        include: {
          paymentLink: {
            select: {
              amount:        true,
              currency:      true,
              reference:     true,
              description:   true,
              customerEmail: true,
              customerPhone: true,
              customerName:  true,
            },
          },
        },
      }),
    );

    if (!intent) return { skipped: true, reason: 'intent-not-found' };

    // ── Fetch tenant notification settings ───────────────────────────────────
    const tenant = await step.run('fetch-tenant', async () =>
      prisma.tenant.findUnique({
        where:  { id: tenantId },
        select: {
          name:               true,
          notifyEmail:        true,
          notifyWebhookUrl:   true,
        },
      }),
    );

    if (!tenant) return { skipped: true, reason: 'tenant-not-found' };

    const results: Record<string, unknown> = {};

    // ── Outbound webhook (always attempted if configured) ────────────────────
    if (tenant.notifyWebhookUrl) {
      results.outboundWebhook = await step.run('outbound-webhook', async () => {
        const body = JSON.stringify({
          event:       'payment.updated',
          status,
          intentId,
          reference:   intent.paymentLink?.reference,
          amount:      intent.paymentLink ? Number(intent.paymentLink.amount) : null,
          currency:    intent.paymentLink?.currency,
          occurredAt:  new Date().toISOString(),
        });

        const resp = await fetch(tenant.notifyWebhookUrl!, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        return { status: resp.status, ok: resp.ok };
      });
    }

    // ── Email notification (placeholder — wire up Resend / SendGrid / etc.) ──
    if (tenant.notifyEmail && intent.paymentLink?.customerEmail) {
      results.email = await step.run('send-email', async () => {
        // TODO: replace this stub with your email adapter
        // e.g. await resend.emails.send({ from: '...', to: ..., subject: ..., html: ... });
        console.info('[notifications] email stub fired', {
          to:      intent.paymentLink!.customerEmail,
          status,
          intentId,
        });
        return { sent: false, reason: 'stub-not-implemented' };
      });
    }

    return { intentId, status, results };
  },
);
