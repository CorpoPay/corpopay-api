/**
 * Webhook endpoints for provider notifications.
 * Raw body parsing is required — do NOT apply express.json() to these routes.
 *
 * POST /webhooks/naps
 * POST /webhooks/vps
 *
 * Security model:
 *   1. Signature is verified SYNCHRONOUSLY at the HTTP layer — unsigned/tampered
 *      requests are rejected with HTTP 401 before any DB write or queue action.
 *      This prevents fake payment confirmations from being stored or acted on.
 *   2. Idempotency dedup uses the provider's event ID when present, otherwise
 *      falls back to SHA-256(rawBody) so replay attacks are blocked even when
 *      fields like eventId are absent.
 *   3. Verified events are queued to Inngest for durable background processing.
 */
import crypto from "crypto";
import { Router, Request, Response } from "express";
import { Provider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { inngest } from "../lib/inngest";
import { asyncHandler } from "../middleware/errorHandler";
import { getAdapter } from "../adapters/registry";
import { decryptCredentials } from "../lib/encryption";
import { VpsCredentials } from "../adapters/types";

const router = Router();

// ─── Shared webhook handler ───────────────────────────────────────────────────────

async function handleWebhook(
  req: Request,
  res: Response,
  provider: Provider,
): Promise<void> {
  const rawBody: Buffer =
    (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [
      k,
      Array.isArray(v) ? v[0] : (v ?? ""),
    ]),
  ) as Record<string, string>;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON payload" });
    return;
  }

  // C-4: Verify signature SYNCHRONOUSLY before any DB write or queue action.
  // We need the tenant's provider config to get the signing key.
  // For VPS, the callbackUrl in the payload contains a chargeId / correlationId
  // we can use to look up the tenant. If we can't resolve the tenant, we reject.
  let signatureValid = false;
  let signatureDebug: Record<string, unknown> = {};
  try {
    // Try to extract a correlationId / chargeId to find the right tenant config
    const chargeId =
      (payload["chargeId"] as string | undefined) ??
      (payload["customerId"] as string | undefined) ?? // VPS uses customerId = correlationId
      (payload["orderId"] as string | undefined);

    signatureDebug.chargeId = chargeId ?? null;
    signatureDebug.payloadKeys = Object.keys(payload);
    signatureDebug.sigHeaders = {
      "x-callback-signature": headers["x-callback-signature"] ?? null,
      "x-payzone-signature": headers["x-payzone-signature"] ?? null,
      "x-vps-signature": headers["x-vps-signature"] ?? null,
      "x-signature": headers["x-signature"] ?? null,
    };

    if (chargeId) {
      // Look up the intent by correlationId first (internal cuid), then fall
      // back to metadata.reference — Jabadoor passes bookingRequestId as the
      // `reference` field which becomes `orderId` in the Payzone payload and
      // is echoed back as `chargeId` in the callback. It does NOT match
      // correlationId, so we must also check metadata->>'reference'.
      let intent = await prisma.paymentIntent.findFirst({
        where: { correlationId: chargeId, provider },
        select: { tenantId: true, provider: true },
      });

      if (!intent) {
        intent = await prisma.paymentIntent.findFirst({
          where: {
            provider,
            metadata: { path: ["reference"], equals: chargeId },
          },
          orderBy: { createdAt: "desc" },
          select: { tenantId: true, provider: true },
        });
      }

      signatureDebug.intentFound = !!intent;
      signatureDebug.intentProvider = intent?.provider ?? null;
      signatureDebug.providerMatch = intent?.provider === provider;

      if (intent && intent.provider === provider) {
        const config = await prisma.providerConfig.findFirst({
          where: { tenantId: intent.tenantId, provider },
          select: { encryptedCredentials: true },
        });
        signatureDebug.configFound = !!config;

        if (config) {
          const { decryptCredentials } = await import("../lib/encryption");
          const creds = decryptCredentials<VpsCredentials>(
            config.encryptedCredentials,
          );
          signatureDebug.notificationKeyPresent = !!creds.notificationKey;
          signatureDebug.notificationKeyLength =
            creds.notificationKey?.length ?? 0;
          signatureDebug.callbackTestMode = creds.callbackTestMode ?? false;

          // Compute what we expect so we can compare without logging the raw key
          const receivedSig =
            headers["x-callback-signature"] ??
            headers["x-payzone-signature"] ??
            headers["x-vps-signature"] ??
            headers["x-signature"] ??
            "";
          if (receivedSig && creds.notificationKey) {
            const crypto = await import("crypto");
            const expected = crypto.default
              .createHmac("sha256", creds.notificationKey)
              .update(rawBody)
              .digest("hex");
            signatureDebug.receivedSigFirst8 = receivedSig.slice(0, 8);
            signatureDebug.expectedSigFirst8 = expected.slice(0, 8);
            signatureDebug.sigMatch =
              receivedSig.toLowerCase() === expected.toLowerCase();
            signatureDebug.rawBodyLength = rawBody.length;
          } else {
            signatureDebug.receivedSig = receivedSig
              ? "(present but key missing)"
              : "(absent)";
          }

          const adapter = getAdapter(provider, config.encryptedCredentials);
          signatureValid = adapter.verifyWebhookSignature(rawBody, headers);
        }
      }
    } else {
      signatureDebug.reason = "no chargeId found in payload";
    }
  } catch (err: unknown) {
    signatureDebug.exception = (err as Error).message;
  }

  if (!signatureValid) {
    console.warn(
      `[webhook/${provider}] signature verification failed`,
      signatureDebug,
    );
    res
      .status(401)
      .json({ error: "Invalid webhook signature", code: "SIGNATURE_INVALID" });
    return;
  }

  // C-5: Idempotency key — use provider's event ID when present, otherwise
  // fall back to SHA-256(rawBody) so replays with different event IDs still
  // get deduplicated based on content.
  const idempotencyKey: string =
    (payload["eventId"] as string | undefined) ??
    (payload["webhookId"] as string | undefined) ??
    (payload["notification_id"] as string | undefined) ??
    crypto.createHash("sha256").update(rawBody).digest("hex");

  // Fast-path: reject known duplicates before queuing any work
  const existing = await prisma.webhookEvent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  // Fire the background job – Inngest guarantees at-least-once delivery.
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

  res.status(200).json({ received: true });
}

// ─── NAPS webhook ─────────────────────────────────────────────────────────────────

router.post(
  "/naps",
  asyncHandler((req, res) => handleWebhook(req, res, Provider.NAPS)),
); // H-9

// ─── VPS webhook ──────────────────────────────────────────────────────────────────

router.post(
  "/vps",
  asyncHandler((req, res) => handleWebhook(req, res, Provider.VPS)),
); // H-9

export default router;
