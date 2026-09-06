/**
 * Notification sink seam (cloud-agnostic).
 *
 * The `payment/notify` job fans a `payment.updated` event out to the tenant's
 * `notifyWebhookUrl`. Additionally, a private fork can register a publisher to
 * fan the same event out to a message bus (SQS/SNS/Kafka/…). OSS ships no
 * publisher (no-op); the fork registers one at bootstrap (e.g. its Lambda entry
 * calls `setNotificationPublisher`).
 *
 * A publisher may throw `RetryAfterError` (from Inngest) to trigger a fast
 * retry — the caller propagates it unchanged.
 */
export interface NotificationContext {
  messageBody: string;
  tenantId: string;
  intentId: string;
  status: string;
}

export type NotificationPublisher = (
  ctx: NotificationContext,
) => Promise<{ messageId?: string } | undefined>;

let publisher: NotificationPublisher | null = null;

export function setNotificationPublisher(fn: NotificationPublisher): void {
  publisher = fn;
}

export async function publishNotification(
  ctx: NotificationContext,
): Promise<{ messageId?: string } | undefined> {
  if (!publisher) return undefined;
  return publisher(ctx);
}
