/**
 * Job: payment/notify
 *
 * Triggered when a PaymentIntent reaches SUCCEEDED or REFUNDED.
 * 1. POSTs a `payment.updated` event to the tenant's `notifyWebhookUrl` (if set).
 * 2. Publishes the same event to an optional SQS notification queue (if configured).
 *
 * Architecture note — why no step.run() calls:
 *   The original implementation used 3 steps (fetch-intent, fetch-tenant,
 *   outbound-webhook), each requiring a separate HTTP round-trip between
 *   Inngest cloud and the CorpoPay Lambda (~2-3 s each, ~8 s total).
 *   Running everything inline reduces this to a single invocation (~2 s).
 *   If the SQS publish fails, Inngest retries the whole function (retries: 3)
 *   with a 2-second delay via RetryAfterError. DB reads are idempotent so
 *   re-running them on retry is safe.
 */
import { RetryAfterError } from "inngest";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

export const notifications = inngest.createFunction(
  {
    id: "payment-notifications",
    name: "Payment Notifications",
    retries: 3,
  },
  { event: "payment/notify" },
  async ({ event }) => {
    const { intentId, tenantId, status } = event.data as {
      intentId: string;
      tenantId: string;
      status: string;
      webhookEventId: string | null;
    };

    // ── Inline DB reads — no step.run() round-trips ──────────────────────────
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: {
        paymentLink: {
          select: {
            amount: true,
            currency: true,
            reference: true,
            description: true,
            customerEmail: true,
            customerPhone: true,
            customerName: true,
          },
        },
      },
    });

    if (!intent) return { skipped: true, reason: "intent-not-found" };

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        notifyWebhookUrl: true,
      },
    });

    if (!tenant) return { skipped: true, reason: "tenant-not-found" };

    // Build the shared payment event payload once (used by webhook + SQS paths).
    const intentMeta = (intent.metadata ?? {}) as Record<string, unknown>;
    const messageBody = JSON.stringify({
      event: "payment.updated",
      status,
      intentId,
      reference: intent.paymentLink?.reference ?? null,
      amount: intent.paymentLink
        ? Number(intent.paymentLink.amount)
        : ((intentMeta["amount"] as number | undefined) ?? null),
      currency:
        intent.paymentLink?.currency ?? (intentMeta["currency"] as string | undefined) ?? null,
      metadata: intent.paymentLink ? undefined : intentMeta,
      occurredAt: new Date().toISOString(),
    });

    if (!tenant.notifyWebhookUrl) {
      return { skipped: true, reason: "no-notify-url" };
    }

    // ── 1. Direct outbound webhook — the documented purpose of notifyWebhookUrl ──
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(tenant.notifyWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: messageBody,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new RetryAfterError(`outbound webhook returned HTTP ${res.status}`, "2s");
      }
    } catch (err) {
      if (err instanceof RetryAfterError) throw err;
      throw new RetryAfterError(`outbound webhook failed: ${(err as Error).message}`, "2s");
    } finally {
      clearTimeout(timer);
    }

    // ── 2. SQS notification queue (optional) — only when the queue is configured ──
    const queueUrl = process.env.NOTIFICATION_SQS_QUEUE_URL;
    if (queueUrl) {
      const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");

      const sqs = new SQSClient({
        region: process.env.NOTIFICATION_SQS_REGION ?? process.env.AWS_REGION,
      });
      const cmd = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: messageBody,
        MessageAttributes: {
          tenantId: { DataType: "String", StringValue: tenantId },
          intentId: { DataType: "String", StringValue: intentId },
          status: { DataType: "String", StringValue: status },
        },
      });

      try {
        const result = await sqs.send(cmd);
        console.info("[notifications] SQS message sent", {
          messageId: result.MessageId,
          tenantId,
          intentId,
          status,
        });
        return { messageId: result.MessageId };
      } catch (err) {
        // RetryAfterError triggers a fast 2-second retry instead of
        // Inngest's default exponential backoff (~60 s first retry).
        throw new RetryAfterError(`SQS publish failed: ${(err as Error).message}`, "2s");
      }
    }

    return { notified: true };
  },
);
