/**
 * Shared pre-auth capture / void actions.
 *
 * The merchant routes (`POST /payment-intents/:id/capture` and `/:id/cancel`) and
 * the admin enforcement resolve (`POST /admin/risk-decisions/:id/resolve`) both
 * settle or release a held (`AUTHORIZED`) payment intent. Keeping that logic here
 * — instead of duplicating it across routes — means the money path (provider
 * capture/void, atomic status transition, provider-transaction audit row, and
 * Inngest fan-out) has a single source of truth.
 *
 * Amounts cross the provider boundary as integer centimes (see `money.ts`).
 */
import type { Prisma } from "@/generated/prisma/client";

import { getAdapter } from "../adapters/registry";
import { AppError } from "../middleware/errorHandler";
import { inngest } from "./inngest";
import { maskObject } from "./mask";
import { madToCentimes } from "./money";
import { prisma } from "./prisma";

/** The intent shape the capture/void actions load (only the fields they need). */
type IntentWithLink = Prisma.PaymentIntentGetPayload<{
  include: { paymentLink: { select: { amount: true; currency: true } } };
}>;

export interface IntentActionResult {
  intentId: string;
  status: string;
}

interface IntentActionOptions {
  /** When set, scope the action to this tenant (merchant path). Omit for cross-tenant admin. */
  tenantId?: string;
}

/** Resolve the charge amount (centimes) + currency for a captured/voided intent. */
function resolveCharge(intent: IntentWithLink): { amountCents: number; currency: string } {
  const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
  const amountCents = intent.paymentLink
    ? Number(madToCentimes(intent.paymentLink.amount))
    : ((metadata.amount as number | undefined) ?? 0);
  const currency =
    intent.paymentLink?.currency ?? (metadata.currency as string | undefined) ?? "MAD";
  return { amountCents, currency };
}

/** Load the intent with the fields the action needs, honoring an optional tenant scope. */
async function loadIntent(intentId: string, tenantId?: string): Promise<IntentWithLink> {
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: intentId, ...(tenantId ? { tenantId } : {}) },
    include: { paymentLink: { select: { amount: true, currency: true } } },
  });
  if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");
  return intent;
}

/** Revert the AUTHORIZED → PROCESSING lock so a retry is possible. */
function revertLock(intentId: string): Promise<unknown> {
  return prisma.paymentIntent.updateMany({
    where: { id: intentId },
    data: { status: "AUTHORIZED" },
  });
}

/**
 * Settle a pre-authorised payment. The intent must be in `AUTHORIZED` status —
 * the shared "authorized, awaiting capture" state both providers map into.
 */
export async function captureIntent(
  intentId: string,
  options: IntentActionOptions = {},
): Promise<IntentActionResult> {
  const { tenantId } = options;

  // C-1: atomic AUTHORIZED → PROCESSING is the race-condition gate. If two
  // capture requests race, only one updateMany returns count=1.
  const locked = await prisma.paymentIntent.updateMany({
    where: { id: intentId, status: "AUTHORIZED", ...(tenantId ? { tenantId } : {}) },
    data: { status: "PROCESSING" },
  });
  if (locked.count === 0) {
    const existing = await prisma.paymentIntent.findFirst({
      where: { id: intentId, ...(tenantId ? { tenantId } : {}) },
    });
    if (!existing) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");
    throw new AppError(
      409,
      "INVALID_STATE",
      `Cannot capture intent in ${existing.status} state — may already be processing`,
    );
  }

  const intent = await loadIntent(intentId, tenantId);

  if (!intent.providerRef) {
    await revertLock(intentId);
    throw new AppError(400, "MISSING_PROVIDER_REF", "Intent has no provider reference to capture");
  }

  const config = await prisma.providerConfig.findFirst({
    where: { provider: intent.provider, tenantId: intent.tenantId },
  });
  if (!config) throw new AppError(400, "PROVIDER_NOT_CONFIGURED", "Provider config missing");

  const adapter = getAdapter(intent.provider, config.encryptedCredentials);

  const { amountCents, currency } = resolveCharge(intent);
  if (!amountCents) {
    await revertLock(intentId);
    throw new AppError(400, "MISSING_AMOUNT", "Cannot determine amount to capture");
  }

  const result = await adapter.capturePayment(intent.providerRef, amountCents, currency);
  if (!result.success) {
    await revertLock(intentId);
    throw new AppError(502, "CAPTURE_FAILED", "Provider rejected the capture request.");
  }

  const status = result.status ?? "SUCCEEDED";

  await prisma.$transaction([
    prisma.paymentIntent.update({ where: { id: intentId }, data: { status } }),
    prisma.providerTransaction.create({
      data: {
        paymentIntentId: intentId,
        provider: intent.provider,
        rawRequest: maskObject(result.rawRequest ?? {}) as Prisma.InputJsonValue,
        rawResponse: maskObject(result.rawResponse) as Prisma.InputJsonValue,
      },
    }),
  ]);

  await inngest.send({ name: "payment/captured", data: { intentId, tenantId: intent.tenantId } });
  await inngest.send({
    name: "payment/risk-evaluate",
    data: { intentId, tenantId: intent.tenantId },
  });

  return { intentId, status };
}

/**
 * Void/reverse a pre-authorised payment (AUTH_REVERSAL / Stripe cancel). The
 * intent must be in `AUTHORIZED` status.
 */
export async function voidIntent(
  intentId: string,
  options: IntentActionOptions = {},
): Promise<IntentActionResult> {
  const { tenantId } = options;

  const locked = await prisma.paymentIntent.updateMany({
    where: { id: intentId, status: "AUTHORIZED", ...(tenantId ? { tenantId } : {}) },
    data: { status: "PROCESSING" },
  });
  if (locked.count === 0) {
    const existing = await prisma.paymentIntent.findFirst({
      where: { id: intentId, ...(tenantId ? { tenantId } : {}) },
    });
    if (!existing) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");
    throw new AppError(
      409,
      "INVALID_STATE",
      `Cannot cancel intent in ${existing.status} state — may already be processing`,
    );
  }

  const intent = await loadIntent(intentId, tenantId);

  if (!intent.providerRef) {
    await revertLock(intentId);
    throw new AppError(400, "MISSING_PROVIDER_REF", "Intent has no provider reference to cancel");
  }

  const config = await prisma.providerConfig.findFirst({
    where: { provider: intent.provider, tenantId: intent.tenantId },
  });
  if (!config) throw new AppError(400, "PROVIDER_NOT_CONFIGURED", "Provider config missing");

  const adapter = getAdapter(intent.provider, config.encryptedCredentials);

  const { amountCents, currency } = resolveCharge(intent);

  const result = await adapter.cancelPayment(intent.providerRef, amountCents, currency);
  if (!result.success) {
    await revertLock(intentId);
    throw new AppError(502, "CANCEL_FAILED", "Provider rejected the cancellation request.");
  }

  const status = result.status ?? "CANCELED";

  await prisma.$transaction([
    prisma.paymentIntent.update({ where: { id: intentId }, data: { status } }),
    prisma.providerTransaction.create({
      data: {
        paymentIntentId: intentId,
        provider: intent.provider,
        rawRequest: maskObject(result.rawRequest ?? {}) as Prisma.InputJsonValue,
        rawResponse: maskObject(result.rawResponse) as Prisma.InputJsonValue,
      },
    }),
  ]);

  await inngest.send({ name: "payment/canceled", data: { intentId, tenantId: intent.tenantId } });

  return { intentId, status };
}
