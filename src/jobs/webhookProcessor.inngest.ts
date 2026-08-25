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
import type { Provider } from "@/generated/prisma/client";
import { getAdapter } from "../adapters/registry";
import { inngest } from "../lib/inngest";
import { maskObject } from "../lib/mask";
import { madToCentimes } from "../lib/money";
import { prisma } from "../lib/prisma";

export const webhookProcessor = inngest.createFunction(
  {
    id: "webhook-processor",
    name: "Webhook Processor",
    // Inngest deduplicates events with the same id within a 24-h window.
    // We pass the provider-supplied idempotency key as the event id in send().
    triggers: [{ event: "webhook/process" }],
  },
  async ({ event, step }) => {
    const { provider, payloadJson, rawBodyBase64, headers, idempotencyKey } = event.data as {
      provider: Provider;
      payloadJson: Record<string, unknown>;
      rawBodyBase64: string;
      headers: Record<string, string>;
      idempotencyKey: string | null;
    };

    const rawBody = Buffer.from(rawBodyBase64, "base64");
    const payload = payloadJson;

    // ── Step 1: Resolve correlating PaymentIntent ────────────────────────────
    const intent = await step.run("find-intent", async () => {
      // VPS callback body shape (from VPS_API_DOCUMENTATION.md):
      //   orderId    → merchant-supplied orderId   (= PaymentLink.slug / sessionTag)
      //   customerId → merchant-supplied customerId (= PaymentIntent.correlationId)
      //   id         → Payzone's own transaction id
      //
      // Lookup priority (most → least specific):
      //   1. correlationId match  — VPS sends our cuid back as `customerId`
      //   2. providerRef match    — legacy / NAPS path
      //   3. metadata.reference   — Acme passes bookingRequestId as `reference`
      //                             which becomes orderId in Payzone and is echoed
      //                             back as chargeId/orderId in the callback

      const orderId =
        (payload["orderId"] as string | undefined) ??
        (payload["OrderID"] as string | undefined) ??
        (payload["paymentId"] as string | undefined) ??
        null;

      const correlationId = (payload["customerId"] as string | undefined) ?? null;

      // 1. correlationId — most reliable for VPS PayWall flows
      if (correlationId) {
        const byCorrelation = await prisma.paymentIntent.findFirst({
          where: { correlationId, provider },
          include: { paymentLink: { select: { tenantId: true } } },
        });
        if (byCorrelation) return byCorrelation;
      }

      // 2. providerRef — works for NAPS and providers that echo chargeId as orderId
      if (orderId) {
        const byRef = await prisma.paymentIntent.findFirst({
          where: { providerRef: orderId, provider },
          include: { paymentLink: { select: { tenantId: true } } },
        });
        if (byRef) return byRef;
      }

      // 3. metadata.reference — Acme passes bookingRequestId as `reference`
      //    at intent creation time; Payzone echoes it back as orderId/chargeId.
      //    This path is required for all direct (non-PaymentLink) Acme flows.
      if (orderId) {
        const byReference = await prisma.paymentIntent.findFirst({
          where: {
            provider,
            metadata: { path: ["reference"], equals: orderId },
          },
          orderBy: { createdAt: "desc" },
          include: { paymentLink: { select: { tenantId: true } } },
        });
        if (byReference) return byReference;
      }

      return null;
    });

    const tenantId = intent?.tenantId ?? null;

    // ── Step 2: Verify signature ─────────────────────────────────────────────
    const signatureVerified = await step.run("verify-signature", async () => {
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
      (payload["Status"] as string | undefined) ??
      (payload["status"] as string | undefined) ??
      (payload["transactionStatus"] as string | undefined);

    let mappedStatus: string | null = null;
    let processingError: string | null = null;
    let processed = false;

    if (providerStatus && intent && tenantId) {
      const result = await step.run("update-intent-status", async () => {
        const config = await prisma.providerConfig.findFirst({
          where: { tenantId, provider },
        });
        if (!config)
          return {
            mappedStatus: null,
            processingError: "No provider config",
            processed: false,
          };

        try {
          const adapter = getAdapter(provider, config.encryptedCredentials);
          const internalStatus = adapter.mapStatusToInternal(providerStatus);

          const providerTransactionId =
            (payload["transactionId"] as string | undefined) ??
            (payload["TransactionID"] as string | undefined) ??
            (payload["id"] as string | undefined) ?? // VPS sends 'id' as transaction ID
            (payload["internalId"] as string | undefined) ??
            null;

          const terminal = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"];
          if (!terminal.includes(intent.status)) {
            await prisma.paymentIntent.update({
              where: { id: intent.id },
              data: { status: internalStatus },
            });
          }

          if (providerTransactionId) {
            const existing = await prisma.providerTransaction.findFirst({
              where: { paymentIntentId: intent.id },
            });
            if (existing) {
              await prisma.providerTransaction.update({
                where: { id: existing.id },
                data: {
                  providerTransactionId,
                  rawResponse: maskObject(payload) as any,
                },
              });
            }
          }

          if (internalStatus === "SUCCEEDED" && intent.paymentLinkId) {
            await prisma.paymentLink.update({
              where: { id: intent.paymentLinkId },
              data: { status: "PAID" },
            });
          }

          return {
            mappedStatus: internalStatus,
            processingError: null,
            processed: true,
          };
        } catch (err: unknown) {
          return {
            mappedStatus: null,
            processingError: (err as Error).message,
            processed: false,
          };
        }
      });

      mappedStatus = result.mappedStatus;
      processingError = result.processingError;
      processed = result.processed;
    }

    // ── Step 4: Store WebhookEvent record ────────────────────────────────────
    const webhookEvent = await step.run("store-webhook-event", async () => {
      return prisma.webhookEvent.create({
        data: {
          provider,
          tenantId,
          paymentIntentId: intent?.id ?? null,
          rawPayload: maskObject(payload) as any,
          headers: maskObject(headers) as any,
          signatureVerified,
          processed,
          processingError,
          mappedStatus,
          idempotencyKey,
        },
      });
    });

    // ── Step 5: Fire notification webhook for all significant status transitions ──
    // Covers terminal states (SUCCEEDED, FAILED, CANCELLED, REFUNDED) as well as
    // AUTHORIZED (pre-auth confirmed — required for Acme request-booking flow).
    const notifiableStatuses = new Set([
      "AUTHORIZED", // Pre-auth confirmed → host approval needed (request booking)
      "SUCCEEDED", // Full capture       → instant booking complete
      "FAILED", // Payment declined
      "CANCELLED", // Void / auth-reversal
      "REFUNDED", // Post-capture refund
    ]);

    if (processed && mappedStatus && notifiableStatuses.has(mappedStatus) && tenantId) {
      await step.sendEvent("send-payment-notification", {
        name: "payment/notify",
        data: {
          intentId: intent!.id,
          tenantId: tenantId!,
          status: mappedStatus,
          webhookEventId: webhookEvent.id,
        },
      });
    }

    // ── Step 6: Bootstrap recurring subscription if applicable ───────────────
    // When a VPS payment succeeds on a recurring Payment Link, Payzone includes
    // a storedPaymentProfileId in the callback.  We create a Subscription record
    // and fire the activation workflow.
    if (provider === "VPS" && processed && mappedStatus === "SUCCEEDED" && intent?.paymentLinkId) {
      await step.run("bootstrap-subscription", async () => {
        const link = await prisma.paymentLink.findUnique({
          where: { id: intent.paymentLinkId! },
        });

        if (!link || !link.isRecurring) return null;

        // Payzone sends storedPaymentProfileId in the callback body
        const storedProfileId =
          (payload["storedPaymentProfileId"] as string | undefined) ??
          (payload["paymentProfileId"] as string | undefined) ??
          (payload["profileId"] as string | undefined) ??
          null;

        if (!storedProfileId) {
          console.warn("[webhook] Recurring link but no storedPaymentProfileId in payload", {
            intentId: intent.id,
          });
          return null;
        }

        // Idempotency: check if a subscription already exists for this intent
        const existing = await prisma.subscription.findUnique({
          where: { initialPaymentIntentId: intent.id },
        });
        if (existing) return existing;

        // Encrypt the stored payment profile before any DB write — never store the
        // raw profile ID, even transiently. Mirrors the BNPL path in step 7.
        const { encrypt } = await import("../lib/encryption");
        const encryptedProfileId = encrypt(storedProfileId);

        const subscription = await prisma.subscription.create({
          data: {
            tenantId: intent.tenantId,
            customerId: (payload["customerId"] as string | undefined) ?? intent.correlationId,
            encryptedStoredProfileId: encryptedProfileId,
            initialPaymentIntentId: intent.id,
            paymentLinkId: link.id,
            status: "PENDING",
            amount: link.amount,
            currency: link.currency,
            intervalType: link.billingInterval!,
            intervalValue: link.intervalValue ?? 1,
            maxRetries: link.maxRetries,
          },
        });

        await inngest.send({
          id: `sub-activated-${subscription.id}`,
          name: "billing/subscription.activated",
          data: {
            subscriptionId: subscription.id,
            tenantId: intent.tenantId,
            customerId: subscription.customerId,
            amount: madToCentimes(link.amount), // centimes
            currency: link.currency,
            intervalType: link.billingInterval,
            intervalValue: link.intervalValue ?? 1,
          },
        });

        return subscription;
      });
    }

    // ── Step 7: Bootstrap BNPL installment agreement if applicable ───────────
    // When a VPS payment succeeds on an installment link (or intent tagged with
    // an installmentAgreementId), activate the agreement with the real profileId.
    const installmentAgreementId = (intent?.metadata as Record<string, unknown> | null)?.[
      "installmentAgreementId"
    ] as string | undefined;

    if (provider === "VPS" && processed && mappedStatus === "SUCCEEDED" && installmentAgreementId) {
      await step.run("bootstrap-installment-agreement", async () => {
        const storedProfileId =
          (payload["storedPaymentProfileId"] as string | undefined) ??
          (payload["paymentProfileId"] as string | undefined) ??
          (payload["profileId"] as string | undefined) ??
          null;

        if (!storedProfileId) {
          console.warn("[webhook] BNPL but no storedPaymentProfileId in payload", {
            installmentAgreementId,
          });
          return null;
        }

        // Idempotency: check if already activated
        const agreement = await prisma.installmentAgreement.findUnique({
          where: { id: installmentAgreementId },
        });
        if (!agreement || agreement.status !== "PENDING_CHECKOUT") return null;

        // Encrypt the real profile ID
        const { encrypt } = await import("../lib/encryption");
        const encryptedProfileId = encrypt(storedProfileId);

        // First installment charge row (the down payment)
        const nextChargeDate = new Date();
        nextChargeDate.setUTCMonth(nextChargeDate.getUTCMonth() + 1);

        await prisma.$transaction([
          prisma.installmentAgreement.update({
            where: { id: installmentAgreementId },
            data: {
              encryptedStoredProfileId: encryptedProfileId,
              status: "ACTIVE",
              paidCount: 1,
              nextChargeDate,
            },
          }),
          prisma.installmentCharge.create({
            data: {
              agreementId: installmentAgreementId,
              installmentNumber: 1,
              dueDate: new Date(),
              amount: agreement.downPayment,
              currency: agreement.currency,
              status: "CHARGED",
              chargeId: `down-${installmentAgreementId}`,
              attemptNumber: 1,
              processedAt: new Date(),
            },
          }),
        ]);

        // Fire charge for installment #2 (scheduled for next month)
        if (agreement.totalInstallments > 1) {
          const nextChargeId = `inst-${installmentAgreementId.slice(-8)}-2`;
          const nextIdem = `${installmentAgreementId}-inst-2`;
          await inngest.send({
            id: nextIdem,
            name: "billing/installment.charge.due",
            data: {
              agreementId: installmentAgreementId,
              installmentNumber: 2,
              tenantId: agreement.tenantId,
              chargeId: nextChargeId,
              idempotencyId: nextIdem,
            },
          });
        } else {
          // Single-installment agreement — already complete
          await prisma.installmentAgreement.update({
            where: { id: installmentAgreementId },
            data: { status: "COMPLETED", nextChargeDate: null },
          });
        }

        return { activated: true, installmentAgreementId };
      });
    }

    return { webhookEventId: webhookEvent.id, processed, mappedStatus };
  },
);
