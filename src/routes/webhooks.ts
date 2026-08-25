/**
 * Webhook endpoints for provider notifications.
 * Raw body parsing is required — do NOT apply express.json() to these routes.
 *
 * POST /webhooks/naps
 * POST /webhooks/vps
 * POST /webhooks/stripe
 *
 * Security model:
 *   1. Signature is verified SYNCHRONOUSLY via verifyWebhook() (see
 *      src/lib/webhook-verify.ts) — unsigned/tampered requests are rejected
 *      with HTTP 401 before any DB write or queue action. This prevents fake
 *      payment confirmations from being stored or acted on.
 *   2. Idempotency dedup uses the provider's event ID when present, otherwise
 *      falls back to SHA-256(rawBody) so replay attacks are blocked even when
 *      fields like eventId are absent.
 *   3. Verified events are queued to Inngest for durable background processing.
 *
 * Stripe-specific notes:
 *   - Stripe sends a `Stripe-Signature` header; verification uses
 *     stripe.webhooks.constructEvent() inside the StripeAdapter.
 *   - The correlationId is stored in event.data.object.metadata.correlationId
 *     (set at Checkout Session creation time).
 *   - The Stripe event ID (evt_xxx) is used as the idempotency key.
 */
import crypto from "crypto";
import { type Request, type Response, Router } from "express";
import { Provider } from "@/generated/prisma/client";
import { inngest } from "../lib/inngest";
import { trackMetric } from "../lib/metrics";
import { prisma } from "../lib/prisma";
import {
  type VerifyWebhookFailure,
  type VerifyWebhookResult,
  verifyWebhook,
} from "../lib/webhook-verify";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── Request helpers ────────────────────────────────────────────────────────────

function rawBodyOf(req: Request): Buffer {
  return (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body));
}

function normalizeHeaders(req: Request): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v ?? "")]),
  ) as Record<string, string>;
}

/**
 * Write the HTTP response for a failed verification and return true. Acts as a
 * type guard so the caller can `return` and let `verification` narrow to the
 * success variant. Invalid JSON is a 400; every other failure is a 401.
 */
function rejectInvalidVerification(
  res: Response,
  provider: Provider,
  result: VerifyWebhookResult,
): result is VerifyWebhookFailure {
  if (result.ok) return false;

  if (result.failReason === "invalid_json") {
    res.status(400).json({ error: "Invalid JSON payload" });
  } else {
    console.warn(`[webhook/${provider}] 401 — ${result.failReason}`, result.failMeta);
    res.status(401).json({ error: "Invalid webhook signature", code: "SIGNATURE_INVALID" });
  }
  return true;
}

// ─── Shared NAPS/VPS handler ────────────────────────────────────────────────────

async function handleProviderWebhook(
  req: Request,
  res: Response,
  provider: Provider,
): Promise<void> {
  const rawBody = rawBodyOf(req);
  const headers = normalizeHeaders(req);

  const verification = await verifyWebhook(provider, rawBody, headers);
  if (rejectInvalidVerification(res, provider, verification)) return;

  const payload = verification.payload;

  // Idempotency key — use provider's event ID when present, otherwise fall back
  // to SHA-256(rawBody) so replays with different event IDs still deduplicate.
  const idempotencyKey: string =
    (payload["eventId"] as string | undefined) ??
    (payload["webhookId"] as string | undefined) ??
    (payload["notification_id"] as string | undefined) ??
    crypto.createHash("sha256").update(rawBody).digest("hex");

  const existing = await prisma.webhookEvent.findUnique({ where: { idempotencyKey } });
  if (existing) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  await inngest.send({
    id: `${provider}:${idempotencyKey}`, // dedup at queue level too
    name: "webhook/process",
    data: {
      provider,
      payloadJson: payload,
      rawBodyBase64: rawBody.toString("base64"),
      headers,
      idempotencyKey,
      signatureVerified: true, // already verified above
    },
  });

  trackMetric("corpopay.webhook.received", 1, [`provider:${provider}`]);

  res.status(200).json({ received: true });
}

// ─── NAPS webhook ────────────────────────────────────────────────────────────────

router.post(
  "/naps",
  asyncHandler((req, res) => handleProviderWebhook(req, res, Provider.NAPS)),
); // H-9

// ─── VPS webhook ─────────────────────────────────────────────────────────────────

router.post(
  "/vps",
  asyncHandler((req, res) => handleProviderWebhook(req, res, Provider.VPS)),
); // H-9

// ─── Stripe webhook ──────────────────────────────────────────────────────────────
//
// Stripe's flow differs from NAPS/VPS only in idempotency (event ID) and queue
// event name; signature verification is the same shared verifyWebhook() path.

router.post(
  "/stripe",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const rawBody = rawBodyOf(req);
    const headers = normalizeHeaders(req);

    const verification = await verifyWebhook(Provider.STRIPE, rawBody, headers);
    if (rejectInvalidVerification(res, Provider.STRIPE, verification)) return;

    const payload = verification.payload;

    // Stripe event IDs (evt_xxx) are globally unique.
    const idempotencyKey: string = payload["id"] as string;

    const existing = await prisma.webhookEvent.findUnique({ where: { idempotencyKey } });
    if (existing) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    await inngest.send({
      id: `STRIPE:${idempotencyKey}`,
      name: "webhook/stripe.process",
      data: {
        payloadJson: payload,
        rawBodyBase64: rawBody.toString("base64"),
        headers,
        idempotencyKey,
        signatureVerified: true,
      },
    });

    res.status(200).json({ received: true });
  }),
);

export default router;
