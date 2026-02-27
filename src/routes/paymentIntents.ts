/**
 * Merchant POST /payment-intents              – create a payment intent directly (no Payment Link required)
 * Merchant GET  /payment-intents/:id          – get intent detail
 * Merchant GET  /payment-intents/:id/status   – poll latest status from provider
 * Merchant POST /payment-intents/:id/capture  – capture a pre-authorised payment (VPS only)
 * Merchant POST /payment-intents/:id/cancel   – void/cancel a pre-authorised payment (VPS only)
 * Public   POST /public/checkout/:slug/pay    – creates a PaymentIntent from a Payment Link and redirects
 */
import { Router } from 'express';
import { z } from 'zod';
import { Provider } from '@prisma/client';
import { prisma }   from '../lib/prisma';
import { inngest }  from '../lib/inngest';
import { requireAuth, requireMerchant } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { getAdapter } from '../adapters/registry';
import { maskObject } from '../lib/mask';
import { computeInstallmentAmount } from '../lib/billing';

// ─── Merchant router ─────────────────────────────────────────────────────────────

const router = Router();

// ── POST /payment-intents — direct programmatic creation ──────────────────────────
//
// Intended for B2B tenants (e.g. jabadoor) that initiate payments from their
// backend via API key, without a hosted Payment Link page.

const CreateIntentSchema = z.object({
  provider:        z.nativeEnum(Provider),
  amount:          z.number().int().positive(),        // in centimes
  currency:        z.string().default('MAD'),
  reference:       z.string().min(1),
  description:     z.string().min(1),
  returnUrl:       z.string().url(),
  successUrl:      z.string().url().optional(),
  cancelUrl:       z.string().url().optional(),
  failureUrl:      z.string().url().optional(),
  webhookUrl:      z.string().url().optional(),        // overrides default callback URL
  customerEmail:   z.string().email().optional(),
  customerName:    z.string().optional(),
  customerPhone:   z.string().optional(),
  customerCountry: z.string().optional(),
  customerLocale:  z.string().optional(),
  isPreauth:       z.boolean().optional(),
  metadata:        z.record(z.unknown()).optional(),
});

router.post(
  '/',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const body = CreateIntentSchema.parse(req.body);

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: req.user!.tenantId, provider: body.provider, status: 'CONNECTED' },
    });
    if (!config) {
      throw new AppError(503, 'PROVIDER_UNAVAILABLE', `Provider ${body.provider} is not configured or not connected`);
    }

    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId:  req.user!.tenantId,
        provider:  body.provider,
        status:    'CREATED',
        metadata:  body.metadata as any ?? null,
        // paymentLinkId intentionally null — direct intent
      },
    });

    const adapter  = getAdapter(body.provider, config.encryptedCredentials);
    const apiBase  = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const callbackUrl = body.webhookUrl ?? `${apiBase}/webhooks/${body.provider.toLowerCase()}`;

    const result = await adapter.createCheckoutSession({
      amount:          body.amount,
      currency:        body.currency,
      reference:       body.reference,
      description:     body.description,
      returnUrl:       body.returnUrl,
      successUrl:      body.successUrl,
      cancelUrl:       body.cancelUrl,
      failureUrl:      body.failureUrl,
      webhookUrl:      callbackUrl,
      customerEmail:   body.customerEmail,
      customerName:    body.customerName,
      customerPhone:   body.customerPhone,
      customerCountry: body.customerCountry,
      customerLocale:  body.customerLocale,
      isPreauth:       body.isPreauth,
      correlationId:   intent.correlationId,
    });

    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data:  {
          status:       'REQUIRES_ACTION',
          providerRef:  result.providerRef,
          providerData: result.providerData as any ?? null,
          // Persist amount + currency in metadata so /capture and /cancel can resolve them
          // without needing the caller to pass them again
          metadata: {
            ...(body.metadata ?? {}),
            amount:   body.amount,
            currency: body.currency,
          },
        },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider:        body.provider,
          rawRequest:      maskObject(result.rawRequest) as any,
          rawResponse:     maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: 'payment/poll-status',
      data: {
        intentId:    intent.id,
        provider:    body.provider,
        tenantId:    req.user!.tenantId,
        providerRef: result.providerRef,
      },
    });

    res.status(201).json({
      intentId:      intent.id,
      correlationId: intent.correlationId,
      // checkoutUrl is the hosted relay page — Jabadoor redirects their customer here.
      // CorpoPay auto-submits the Payzone form on the customer's behalf.
      checkoutUrl:  `${webBase}/pay/${intent.correlationId}`,
      providerData:  result.providerData ?? null,
    });
  }),
);

// ── GET /payment-intents/:id ───────────────────────────────────────────────────

router.get(
  '/:id',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: {
        paymentLink:  { select: { slug: true, amount: true, currency: true, description: true, reference: true, customerName: true, customerEmail: true, customerPhone: true } },
        providerTxs:  { select: { id: true, provider: true, providerTransactionId: true, rawResponse: true, createdAt: true } },
        refunds:      { select: { id: true, status: true, amount: true, createdAt: true } },
        webhookEvents: { select: { id: true, signatureVerified: true, processed: true, mappedStatus: true, createdAt: true } },
      },
    });
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Payment intent not found');
    res.json(intent);
  }),
);

// ── GET /payment-intents/:id/status ───────────────────────────────────────────

router.get(
  '/:id/status',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: { paymentLink: true },
    });
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Payment intent not found');

    // If already in a terminal state, return immediately
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED'];
    if (terminal.includes(intent.status)) {
      return res.json({ status: intent.status, providerRef: intent.providerRef });
    }

    if (!intent.providerRef) {
      return res.json({ status: intent.status, providerRef: null });
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: req.user!.tenantId, provider: intent.provider },
    });
    if (!config) throw new AppError(400, 'PROVIDER_NOT_CONFIGURED', 'Provider config missing');

    const adapter = getAdapter(intent.provider, config.encryptedCredentials);
    const result  = await adapter.queryTransactionStatus(intent.providerRef);

    if (result.status !== intent.status) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data:  { status: result.status },
      });
    }

    return res.json({ status: result.status, providerRef: intent.providerRef });
  }),
);

// ── POST /payment-intents/:id/capture ─────────────────────────────────────────
//
// Settle a pre-authorised payment. Only applicable for VPS pre-auth flow
// (doFundsAuthOnly: true). Intent must be in REQUIRES_ACTION status.

router.post(
  '/:id/capture',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: { paymentLink: true },
    });
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Payment intent not found');

    if (intent.status !== 'REQUIRES_ACTION') {
      throw new AppError(400, 'INVALID_STATE', `Cannot capture intent in ${intent.status} state`);
    }
    if (!intent.providerRef) {
      throw new AppError(400, 'MISSING_PROVIDER_REF', 'Intent has no provider reference to capture');
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: req.user!.tenantId, provider: intent.provider },
    });
    if (!config) throw new AppError(400, 'PROVIDER_NOT_CONFIGURED', 'Provider config missing');

    const adapter = getAdapter(intent.provider, config.encryptedCredentials);

    // Resolve amount: from PaymentLink if linked, else from metadata
    const amount   = intent.paymentLink
      ? Number(intent.paymentLink.amount) * 100   // stored as MAD, convert to centimes
      : ((intent.metadata as any)?.amount as number | undefined);
    const currency = intent.paymentLink?.currency ?? ((intent.metadata as any)?.currency as string | undefined) ?? 'MAD';

    if (!amount) {
      throw new AppError(400, 'MISSING_AMOUNT', 'Cannot determine amount to capture');
    }

    const result = await adapter.capturePayment(intent.providerRef, amount, currency);

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data:  { status: 'SUCCEEDED' },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider:        intent.provider,
          rawResponse:     maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: 'payment/captured',
      data: { intentId: intent.id, tenantId: intent.tenantId },
    });

    res.json({ intentId: intent.id, status: 'SUCCEEDED' });
  }),
);

// ── POST /payment-intents/:id/cancel ──────────────────────────────────────────
//
// Void/reverse a pre-authorised payment (AUTH_REVERSAL). Intent must be in
// REQUIRES_ACTION status.

router.post(
  '/:id/cancel',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: { paymentLink: true },
    });
    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Payment intent not found');

    if (intent.status !== 'REQUIRES_ACTION') {
      throw new AppError(400, 'INVALID_STATE', `Cannot cancel intent in ${intent.status} state`);
    }
    if (!intent.providerRef) {
      throw new AppError(400, 'MISSING_PROVIDER_REF', 'Intent has no provider reference to cancel');
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: req.user!.tenantId, provider: intent.provider },
    });
    if (!config) throw new AppError(400, 'PROVIDER_NOT_CONFIGURED', 'Provider config missing');

    const adapter  = getAdapter(intent.provider, config.encryptedCredentials);
    const amount   = intent.paymentLink
      ? Number(intent.paymentLink.amount) * 100
      : ((intent.metadata as any)?.amount as number | undefined) ?? 0;
    const currency = intent.paymentLink?.currency ?? ((intent.metadata as any)?.currency as string | undefined) ?? 'MAD';

    const result = await adapter.cancelPayment(intent.providerRef, amount, currency);

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data:  { status: 'CANCELED' },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider:        intent.provider,
          rawResponse:     maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: 'payment/canceled',
      data: { intentId: intent.id, tenantId: intent.tenantId },
    });

    res.json({ intentId: intent.id, status: 'CANCELED' });
  }),
);

export default router;

// ─── Public relay router ─────────────────────────────────────────────────────────
//
// GET /public/pay/:correlationId
//
// Serves the persisted providerData for the hosted relay page at
// app.corpopay.site/pay/:correlationId. The relay page auto-submits the Payzone
// form on the customer's behalf — the API client only needs to redirect their
// customer to checkoutUrl.
//
// Security: correlationId is a 25-char CUID (~125-bit entropy) — safe to expose
// publicly. Terminal intents return status only (no providerData) so completed
// Payzone sessions cannot be replayed.

export const publicRelayRouter = Router();

publicRelayRouter.get(
  '/:correlationId',
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where:  { correlationId: req.params.correlationId },
      select: { status: true, providerData: true },
    });

    if (!intent) throw new AppError(404, 'INTENT_NOT_FOUND', 'Payment session not found');

    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED'];
    if (terminal.includes(intent.status)) {
      return res.json({ status: intent.status, providerData: null });
    }

    return res.json({ status: intent.status, providerData: intent.providerData });
  }),
);

// ─── Public router ────────────────────────────────────────────────────────────────

const PaySchema = z.object({
  customerIp:         z.string().optional(),
  customerEmail:      z.string().email().optional().or(z.literal('')),
  customerName:       z.string().optional(),
  // BNPL
  installmentPlanId:  z.string().optional(),
  downPaymentAmount:  z.number().positive().optional(), // MAD, must >= one installment
});

export const publicPayRouter = Router();

publicPayRouter.post(
  '/:slug/pay',
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where:   { slug: req.params.slug },
      include: { tenant: { select: { id: true, status: true } } },
    });

    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Payment link not found');
    if (link.tenant.status === 'DISABLED') throw new AppError(403, 'TENANT_DISABLED', 'Merchant not accepting payments');
    if (link.status !== 'ACTIVE') throw new AppError(410, 'LINK_INACTIVE', 'This payment link is no longer active');
    if (link.expiresAt && link.expiresAt < new Date()) throw new AppError(410, 'LINK_EXPIRED', 'Payment link expired');
    if (link.attemptCount >= link.maxAttempts) throw new AppError(429, 'MAX_ATTEMPTS', 'Maximum payment attempts reached');

    const { customerIp, customerEmail, customerName, installmentPlanId, downPaymentAmount } =
      PaySchema.parse(req.body);

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: link.tenantId, provider: link.provider, status: 'CONNECTED' },
    });
    if (!config) throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Payment provider not available');

    const adapter = getAdapter(link.provider, config.encryptedCredentials);

    const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

    // ── BNPL / Installment path ──────────────────────────────────────────────
    let installmentAgreementId: string | undefined;
    let chargeCentimes = Math.round(Number(link.amount) * 100); // default: full amount

    if (installmentPlanId) {
      if (!link.isInstallment) {
        throw new AppError(400, 'NOT_INSTALLMENT_LINK', 'This payment link does not support installments');
      }

      const plan = await prisma.installmentPlan.findFirst({
        where: { id: installmentPlanId, tenantId: link.tenantId, isActive: true },
      });
      if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'Installment plan not found or not active');

      const principal = Number(link.amount);
      const apr       = Number(plan.annualInterestRate);
      const n         = plan.durationMonths;

      // Validate amount constraints
      if (plan.minAmount && principal < Number(plan.minAmount)) {
        throw new AppError(400, 'AMOUNT_BELOW_MIN', `Minimum amount for this plan is ${plan.minAmount}`);
      }
      if (plan.maxAmount && principal > Number(plan.maxAmount)) {
        throw new AppError(400, 'AMOUNT_ABOVE_MAX', `Maximum amount for this plan is ${plan.maxAmount}`);
      }

      // Standard amortization: full n months on the principal
      const standardInstallment = computeInstallmentAmount(principal, apr, n);

      // Down payment: caller-supplied or default to one installment; cannot go below one installment
      let downPayment = downPaymentAmount ?? standardInstallment;
      if (downPayment < standardInstallment) {
        downPayment = standardInstallment;
      }
      downPayment = Math.round(downPayment * 100) / 100; // round to 2dp

      // Remaining installments after down payment
      const remainingPrincipal   = Math.max(0, Math.round((principal - downPayment) * 100) / 100);
      const remainingInstallments = n - 1;
      const remainingMonthlyAmt  = remainingInstallments > 0
        ? computeInstallmentAmount(remainingPrincipal, apr, remainingInstallments)
        : 0;
      const totalInstallments    = 1 + (remainingInstallments > 0 ? remainingInstallments : 0);

      // Pre-create intent to get correlationId for the customerId
      const draftIntent = await prisma.paymentIntent.create({
        data: {
          tenantId:      link.tenantId,
          paymentLinkId: link.id,
          provider:      link.provider,
          customerIp:    customerIp ?? (req.ip ?? null),
          metadata:      { bnpl: true }, // will be updated with agreementId below
        },
      });

      // Create InstallmentAgreement (PENDING_CHECKOUT)
      const agreement = await prisma.installmentAgreement.create({
        data: {
          tenantId:               link.tenantId,
          customerId:             draftIntent.correlationId,
          planId:                 plan.id,
          paymentLinkId:          link.id,
          initialPaymentIntentId: draftIntent.id,
          principalAmount:        principal,
          downPayment,
          installmentAmount:      remainingMonthlyAmt > 0 ? remainingMonthlyAmt : downPayment,
          totalInstallments,
          currency:               link.currency,
        },
      });

      // Tag the intent with the agreement ID so the webhook processor can find it
      await prisma.paymentIntent.update({
        where: { id: draftIntent.id },
        data:  { metadata: { bnpl: true, installmentAgreementId: agreement.id } },
      });

      await prisma.paymentLink.update({ where: { id: link.id }, data: { attemptCount: { increment: 1 } } });

      // Charge the down payment amount (in centimes)
      chargeCentimes = Math.round(downPayment * 100);
      installmentAgreementId = agreement.id;

      const result = await adapter.createCheckoutSession({
        amount:              chargeCentimes,
        currency:            link.currency,
        reference:           link.reference,
        description:         `${link.description} — Installment Plan (${n} months)`,
        returnUrl:           `${webBase}/checkout/${link.slug}/result?intentId=${draftIntent.id}`,
        webhookUrl:          `${apiBase}/webhooks/${link.provider.toLowerCase()}`,
        customerEmail:       customerEmail ?? link.customerEmail ?? undefined,
        customerName:        customerName  ?? link.customerName  ?? undefined,
        customerPhone:       link.customerPhone ?? undefined,
        correlationId:       draftIntent.correlationId,
        storePaymentProfile: true,
      });

      await prisma.$transaction([
        prisma.paymentIntent.update({
          where: { id: draftIntent.id },
          data:  { status: 'REQUIRES_ACTION', providerRef: result.providerRef },
        }),
        prisma.providerTransaction.create({
          data: {
            paymentIntentId: draftIntent.id,
            provider:        link.provider,
            rawRequest:      maskObject(result.rawRequest) as any,
            rawResponse:     maskObject(result.rawResponse) as any,
          },
        }),
      ]);

      await inngest.send({
        name: 'payment/poll-status',
        data: {
          intentId:    draftIntent.id,
          provider:    link.provider,
          tenantId:    link.tenantId,
          providerRef: result.providerRef,
        },
      });

      return res.json({
        intentId:   draftIntent.id,
        agreementId: agreement.id,
        redirectUrl: result.redirectUrl,
        providerData: result.providerData ?? null,
      });
    }

    // ── Standard (non-installment) path ─────────────────────────────────────

    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId:     link.tenantId,
        paymentLinkId: link.id,
        provider:     link.provider,
        customerIp:   customerIp ?? (req.ip ?? null),
      },
    });

    await prisma.paymentLink.update({
      where: { id: link.id },
      data:  { attemptCount: { increment: 1 } },
    });

    const result = await adapter.createCheckoutSession({
      amount:        chargeCentimes,
      currency:      link.currency,
      reference:     link.reference,
      description:   link.description,
      returnUrl:     `${webBase}/checkout/${link.slug}/result?intentId=${intent.id}`,
      webhookUrl:    `${apiBase}/webhooks/${link.provider.toLowerCase()}`,
      customerEmail: customerEmail ?? link.customerEmail ?? undefined,
      customerName:  customerName  ?? link.customerName  ?? undefined,
      customerPhone: link.customerPhone ?? undefined,
      correlationId: intent.correlationId,
      storePaymentProfile: link.isRecurring === true,
    });

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data:  { status: 'REQUIRES_ACTION', providerRef: result.providerRef },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider:        link.provider,
          rawRequest:      maskObject(result.rawRequest) as any,
          rawResponse:     maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: 'payment/poll-status',
      data: {
        intentId:    intent.id,
        provider:    link.provider,
        tenantId:    link.tenantId,
        providerRef: result.providerRef,
      },
    });

    return res.json({ intentId: intent.id, redirectUrl: result.redirectUrl, providerData: result.providerData ?? null });
  }),
);
