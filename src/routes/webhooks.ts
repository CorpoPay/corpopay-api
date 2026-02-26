/**
 * Webhook endpoints for provider notifications.
 * Raw body parsing is required — do NOT apply express.json() to these routes.
 *
 * POST /webhooks/naps
 * POST /webhooks/vps
 *
 * The route does the minimum work required to guarantee a fast 200 response:
 *   1. Parse the raw body
 *   2. Detect duplicate events by idempotency key
 *   3. Fire an Inngest event to hand off all processing to a durable background job
 *
 * The heavy lifting (signature verification, intent status update, DB writes) is
 * done asynchronously in webhookProcessor.inngest.ts.
 */
import { Router, Request, Response } from 'express';
import { Provider } from '@prisma/client';
import { prisma }   from '../lib/prisma';
import { inngest }  from '../lib/inngest';

const router = Router();

// ─── Shared webhook handler ───────────────────────────────────────────────────────

async function handleWebhook(
  req: Request,
  res: Response,
  provider: Provider,
): Promise<void> {
  const rawBody: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v ?? '']),
  ) as Record<string, string>;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }

  // Extract a provider-supplied event id for idempotency
  const idempotencyKey =
    (payload['eventId']         as string | undefined) ??
    (payload['webhookId']       as string | undefined) ??
    (payload['notification_id'] as string | undefined) ??
    null;

  // Fast-path: reject known duplicates before queuing any work
  if (idempotencyKey) {
    const existing = await prisma.webhookEvent.findUnique({ where: { idempotencyKey } });
    if (existing) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
  }

  // Fire the background job – Inngest guarantees at-least-once delivery.
  // Pass rawBody as base64 so the job can re-run signature verification.
  await inngest.send({
    // Using idempotencyKey as the Inngest event id de-duplicates retries at
    // the queue level in addition to our DB check above.
    ...(idempotencyKey ? { id: `${provider}:${idempotencyKey}` } : {}),
    name: 'webhook/process',
    data: {
      provider,
      payloadJson:   payload,
      rawBodyBase64: rawBody.toString('base64'),
      headers,
      idempotencyKey,
    },
  });

  res.status(200).json({ received: true });
}

// ─── NAPS webhook ─────────────────────────────────────────────────────────────────

router.post('/naps', async (req: Request, res: Response) => {
  await handleWebhook(req, res, Provider.NAPS);
});

// ─── VPS webhook ──────────────────────────────────────────────────────────────────

router.post('/vps', async (req: Request, res: Response) => {
  await handleWebhook(req, res, Provider.VPS);
});

export default router;
