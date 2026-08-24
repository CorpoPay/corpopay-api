/**
 * Single, reusable webhook signature-verification path.
 *
 * The invariant this module enforces: a webhook's signature MUST be verified
 * (via the provider adapter, which knows the tenant's signing key) before any
 * DB write or queue action. Every webhook route funnels through verifyWebhook()
 * so a future endpoint cannot accidentally skip verification.
 *
 * The helper also resolves the tenant for a given provider so the signing key
 * can be fetched from ProviderConfig:
 *   - NAPS/VPS: identify the intent by chargeId/customerId/orderId (with a
 *     metadata.reference fallback), then look up the provider config.
 *   - Stripe: identify the intent by correlationId stored in the event object's
 *     metadata, then look up the provider config.
 */
import { Provider } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { getAdapter } from "../adapters/registry";

type VerifyWebhookSuccess = {
  ok: true;
  payload: Record<string, unknown>;
  tenantId: string;
};

export type VerifyWebhookFailure = {
  ok: false;
  failReason: string;
  failMeta: Record<string, unknown>;
};

export type VerifyWebhookResult = VerifyWebhookSuccess | VerifyWebhookFailure;

export async function verifyWebhook(
  provider: Provider,
  rawBody: Buffer,
  headers: Record<string, string>,
): Promise<VerifyWebhookResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return { ok: false, failReason: "invalid_json", failMeta: {} };
  }

  try {
    let tenantId: string;
    let identifierKey: string;
    let identifierValue: string;

    if (provider === Provider.STRIPE) {
      const eventData = (payload["data"] as Record<string, unknown> | undefined) ?? {};
      const object = (eventData["object"] as Record<string, unknown> | undefined) ?? {};
      const metadata = (object["metadata"] as Record<string, string> | undefined) ?? {};
      const correlationId = metadata["correlationId"] ?? metadata["corpopayRef"] ?? null;

      if (!correlationId) {
        return {
          ok: false,
          failReason: "no_correlation_id",
          failMeta: { eventType: payload["type"], objectKeys: Object.keys(object) },
        };
      }
      identifierKey = "correlationId";
      identifierValue = correlationId;

      const intent = await prisma.paymentIntent.findFirst({
        where: { correlationId, provider },
        select: { tenantId: true },
      });
      if (!intent) {
        return { ok: false, failReason: "intent_not_found", failMeta: { correlationId, provider } };
      }
      tenantId = intent.tenantId;
    } else {
      const chargeId = (payload["chargeId"] ?? payload["customerId"] ?? payload["orderId"]) as
        string | undefined;

      if (!chargeId) {
        return {
          ok: false,
          failReason: "no_charge_id",
          failMeta: { payloadKeys: Object.keys(payload) },
        };
      }
      identifierKey = "chargeId";
      identifierValue = chargeId;

      let intent = await prisma.paymentIntent.findFirst({
        where: { correlationId: chargeId, provider },
        select: { tenantId: true },
      });

      // Fallback: match by metadata.reference — Acme passes bookingRequestId
      // as `reference` which Payzone echoes back as orderId/chargeId.
      if (!intent) {
        intent = await prisma.paymentIntent.findFirst({
          where: {
            provider,
            metadata: { path: ["reference"], equals: chargeId },
          },
          orderBy: { createdAt: "desc" },
          select: { tenantId: true },
        });
      }

      if (!intent) {
        return { ok: false, failReason: "intent_not_found", failMeta: { chargeId, provider } };
      }
      tenantId = intent.tenantId;
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId, provider },
      select: { encryptedCredentials: true },
    });
    if (!config) {
      return {
        ok: false,
        failReason: "provider_config_not_found",
        failMeta: { [identifierKey]: identifierValue, provider },
      };
    }

    const adapter = getAdapter(provider, config.encryptedCredentials);
    const valid = adapter.verifyWebhookSignature(rawBody, headers);
    if (!valid) {
      // Log which signature header was present (value omitted for security).
      const sigHeader =
        provider === Provider.STRIPE
          ? (headers["stripe-signature"] ?? null)
          : (headers["x-callback-signature"] ??
            headers["x-payzone-signature"] ??
            headers["x-vps-signature"] ??
            headers["x-signature"] ??
            null);
      return {
        ok: false,
        failReason: "signature_mismatch",
        failMeta: {
          [identifierKey]: identifierValue,
          provider,
          sigHeaderPresent: sigHeader !== null,
          rawBodyBytes: rawBody.length,
        },
      };
    }

    return { ok: true, payload, tenantId };
  } catch (err: unknown) {
    return { ok: false, failReason: "exception", failMeta: { error: (err as Error).message } };
  }
}
