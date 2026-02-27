/**
 * Admin simulation routes — super-admin only.
 * Mounted at /admin/simulation in app.ts.
 *
 * Legacy (recurring billing sim — kept for backward compat):
 *   POST   /admin/simulation/start          – spin up a simulation subscription + fire billing event
 *   GET    /admin/simulation/status/:id     – poll subscription state + billing events
 *   DELETE /admin/simulation/cleanup/:id    – wipe all records created by this session
 *
 * BNPL Simulation (real VPS sandbox):
 *   POST   /admin/simulation/bnpl/prepare            – create throwaway installment link + PayWall payload
 *   GET    /admin/simulation/bnpl/await-agreement/:linkId – poll for agreement created by webhook
 *   POST   /admin/simulation/bnpl/fire               – launch accelerated installment simulation
 *   GET    /admin/simulation/bnpl/status/:agreementId – live poll agreement + charges
 *   DELETE /admin/simulation/bnpl/cleanup/:agreementId – teardown all sandbox fixtures
 */
import { Router }      from 'express';
import { z }           from 'zod';
import { Provider, PaymentIntentStatus } from '@prisma/client';
import { prisma }      from '../lib/prisma';
import { inngest }     from '../lib/inngest';
import { randomUUID }  from 'crypto';
import { encrypt }     from '../lib/encryption';
import { getAdapter }  from '../adapters/registry';
import { VpsAdapter }  from '../adapters/vps.adapter';
import { requireAuth, requireSuperAdmin } from '../middleware/auth';
import { asyncHandler, AppError }         from '../middleware/errorHandler';
import { billingIdempotencyKey, computeInstallmentAmount } from '../lib/billing';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a seconds value to an Inngest duration string, e.g. 90 → "90s" */
function toDelay(seconds: number): string {
  if (seconds < 60)    return `${seconds}s`;
  if (seconds < 3600)  return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

const SIM_PREFIX = '__SIM_';

// ─── POST /admin/simulation/start ─────────────────────────────────────────────

const StartSchema = z.object({
  tenantId:      z.string().min(1),
  amount:        z.number().positive().default(1.00),   // MAD
  currency:      z.string().default('MAD'),
  /** Seconds between dunning retry 1→2 */
  retryDelay1:   z.number().int().min(5).max(3600).default(30),
  /** Seconds between dunning retry 2→3 */
  retryDelay2:   z.number().int().min(5).max(3600).default(60),
  /** Seconds between dunning retry 3→4 (final) */
  retryDelay3:   z.number().int().min(5).max(3600).default(120),
});

router.post(
  '/start',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const body = StartSchema.parse(req.body);
    const { tenantId, amount, currency, retryDelay1, retryDelay2, retryDelay3 } = body;

    // 1. Confirm tenant has a connected VPS config
    const config = await prisma.providerConfig.findFirst({
      where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) {
      throw new AppError(400, 'NO_VPS_CONFIG', 'Tenant has no connected VPS provider config');
    }

    // 2. Generate a session ID that tags all records we create
    const sessionId  = randomUUID().replace(/-/g, '');
    const customerId = `${SIM_PREFIX}${sessionId}`;

    // 3. Create a dummy PaymentIntent (required FK for Subscription)
    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId,
        provider:     Provider.VPS,
        status:       PaymentIntentStatus.SUCCEEDED,
        metadata:     { simulation: true, sessionId },
      },
    });

    // 4. Create the simulation Subscription
    //    encryptedStoredProfileId: we encrypt a clearly-fake sentinel value.
    //    VPS sandbox will decline this, which is the expected failure path.
    const amountCentimes     = Math.round(amount * 100);
    const subscription       = await prisma.subscription.create({
      data: {
        tenantId,
        customerId,
        encryptedStoredProfileId: encrypt('SIMULATION_PROFILE_ID'),
        initialPaymentIntentId:   intent.id,
        status:                   'ACTIVE',
        amount,
        currency,
        intervalType:   'MONTHLY',
        intervalValue:  1,
        nextBillingDate: new Date(),   // due now
        retryCount:      0,
        maxRetries:      3,
      },
    });

    // 5. Fire the simulation Inngest event
    const chargeId    = `sim-${sessionId}`;
    const idempotency = billingIdempotencyKey(subscription.id, new Date());

    await inngest.send({
      name: 'billing/renewal.simulation',
      data: {
        subscriptionId: subscription.id,
        tenantId,
        customerId,
        amount:         amountCentimes,
        currency,
        intervalType:   'MONTHLY',
        intervalValue:  1,
        chargeId,
        idempotencyId:  idempotency,
        attemptNumber:  1,
        retryDelay1:    toDelay(retryDelay1),
        retryDelay2:    toDelay(retryDelay2),
        retryDelay3:    toDelay(retryDelay3),
      },
    });

    return res.status(201).json({
      sessionId,
      subscriptionId: subscription.id,
      paymentIntentId: intent.id,
      retries: {
        delay1: toDelay(retryDelay1),
        delay2: toDelay(retryDelay2),
        delay3: toDelay(retryDelay3),
      },
    });
  }),
);

// ─── GET /admin/simulation/status/:sessionId ──────────────────────────────────

router.get(
  '/status/:sessionId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const customerId = `${SIM_PREFIX}${sessionId}`;

    const subscription = await prisma.subscription.findFirst({
      where:   { customerId },
      include: {
        billingEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!subscription) {
      throw new AppError(404, 'SIM_NOT_FOUND', 'Simulation session not found');
    }

    const { encryptedStoredProfileId: _redacted, ...safeSub } = subscription;

    return res.json({
      sessionId,
      subscription: safeSub,
      billingEvents: subscription.billingEvents,
      done: ['CANCELLED', 'EXPIRED', 'ACTIVE'].includes(subscription.status) &&
            subscription.billingEvents.length > 0,
    });
  }),
);

// ─── DELETE /admin/simulation/cleanup/:sessionId ───────────────────────────────

router.delete(
  '/cleanup/:sessionId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const customerId = `${SIM_PREFIX}${sessionId}`;

    const subscriptions = await prisma.subscription.findMany({
      where:   { customerId },
      select:  { id: true, initialPaymentIntentId: true },
    });

    if (!subscriptions.length) {
      return res.json({ deleted: { subscriptions: 0, billingEvents: 0, paymentIntents: 0 } });
    }

    const subIds    = subscriptions.map((s) => s.id);
    const intentIds = subscriptions.map((s) => s.initialPaymentIntentId);

    // Delete in FK-safe order: billing events → subscriptions → payment intents
    const events  = await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    const subs    = await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    const intents = await prisma.paymentIntent.deleteMany({ where: { id: { in: intentIds } } });

    return res.json({
      deleted: {
        subscriptions:  subs.count,
        billingEvents:  events.count,
        paymentIntents: intents.count,
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// BNPL / Installment Simulation Routes
// ─────────────────────────────────────────────────────────────────────────────

const BNPL_SIM_PREFIX = '__BNPL_SIM_';

// ── GET /admin/simulation/bnpl/plans/:tenantId ───────────────────────────────
// Returns the tenant's active installment plans so the UI can show APR per duration.

router.get(
  '/bnpl/plans/:tenantId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const plans = await prisma.installmentPlan.findMany({
      where:   { tenantId: req.params.tenantId, isActive: true },
      orderBy: { durationMonths: 'asc' },
    });
    res.json({
      data: plans.map((p) => ({
        id:                 p.id,
        name:               p.name,
        durationMonths:     p.durationMonths,
        annualInterestRate: Number(p.annualInterestRate),
        minAmount:          p.minAmount ? Number(p.minAmount) : null,
        maxAmount:          p.maxAmount ? Number(p.maxAmount) : null,
      })),
    });
  }),
);

// ── POST /admin/simulation/bnpl/prepare ──────────────────────────────────────

router.post(
  '/bnpl/prepare',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { tenantId, amount, months, apr } = z.object({
      tenantId: z.string().min(1),
      amount:   z.number().positive().default(1000),
      months:   z.number().int().min(1).max(120).default(3),
      apr:      z.number().min(0).max(100).default(0),
    }).parse(req.body);

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) throw new AppError(400, 'NO_VPS_CONFIG', 'Tenant has no connected VPS provider config');

    const sessionTag = `${BNPL_SIM_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // 1. Create a throwaway InstallmentPlan with the requested params
    const plan = await prisma.installmentPlan.create({
      data: {
        tenantId,
        name:               sessionTag,
        durationMonths:     months,
        annualInterestRate: apr,
        isActive:           true,
      },
    });

    // 2. Create a throwaway PaymentLink
    const link = await prisma.paymentLink.create({
      data: {
        tenantId,
        provider:      'VPS',
        amount,
        currency:      'MAD',
        description:   `BNPL Simulation — ${amount} MAD / ${months}mo`,
        reference:     sessionTag,
        isInstallment: true,
        maxAttempts:   1,
      },
    });

    // 3. Compute the installment amount using the standard amortization formula
    const installmentAmount = computeInstallmentAmount(amount, apr, months);

    // 4. Create a draft PaymentIntent + InstallmentAgreement (PENDING_CHECKOUT)
    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId,
        paymentLinkId: link.id,
        provider:      'VPS',
        metadata:      { bnplSim: true },
      },
    });

    const agreement = await prisma.installmentAgreement.create({
      data: {
        tenantId,
        customerId:             intent.correlationId,
        planId:                 plan.id,
        paymentLinkId:          link.id,
        initialPaymentIntentId: intent.id,
        principalAmount:        amount,
        downPayment:            installmentAmount,
        installmentAmount,
        totalInstallments:      months,
        currency:               'MAD',
      },
    });

    // Tag intent with agreementId so webhook processor can activate it
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data:  { metadata: { bnplSim: true, installmentAgreementId: agreement.id } },
    });

    // 5. Build a real signed VPS PayWall payload — charge the first installment
    const adapter  = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
    const apiBase  = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const webBase  = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
    const aprLabel = apr === 0 ? '0% APR' : `${apr}% APR`;

    const checkoutResult = await adapter.createCheckoutSession({
      amount:              Math.round(installmentAmount * 100),
      currency:            'MAD',
      reference:           sessionTag,
      description:         `BNPL — ${amount} MAD / ${months}mo (${aprLabel})`,
      returnUrl:           `${webBase}/checkout/success`,
      successUrl:          `${webBase}/checkout/success`,
      failureUrl:          `${webBase}/checkout/failure`,
      webhookUrl:          `${apiBase}/webhooks/vps`,
      correlationId:       intent.correlationId,
      storePaymentProfile: true,
      isPreauth:           true,   // AUTHORIZE mode → triggers 3DS simulator; SETTLE fires after AUTHORIZED
    });

    // Update intent providerRef
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data:  { status: 'REQUIRES_ACTION', providerRef: checkoutResult.providerRef },
    });

    const pd = checkoutResult.providerData ?? {};

    return res.status(201).json({
      linkId:            link.id,
      agreementId:       agreement.id,
      sessionTag,
      paywallUrl:        pd['paywallUrl'] as string,
      paywallPayload:    pd['payload'] as string,
      paywallSignature:  pd['signature'] as string,
      preview: {
        totalInstallments:  months,
        installmentAmount,
        principalAmount:    amount,
        apr,
        currency:           'MAD',
      },
    });
  }),
);

// ── GET /admin/simulation/bnpl/await-agreement/:linkId ───────────────────────
//
// Polls the installment agreement status.  The agreement transitions out of
// PENDING_CHECKOUT via the webhook → inngest pipeline, but since the webhook
// callbackUrl is localhost in dev we also actively query VPS here and manually
// activate the agreement when VPS reports AUTHORISED / CHARGED.

router.get(
  '/bnpl/await-agreement/:linkId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const agreement = await prisma.installmentAgreement.findFirst({
      where:   { paymentLinkId: req.params.linkId },
      include: { initialPaymentIntent: { select: { id: true, correlationId: true, providerRef: true, tenantId: true } } },
    });

    if (!agreement) return res.json({ found: false });

    // Already activated — normal return
    if (agreement.status !== 'PENDING_CHECKOUT') {
      return res.json({
        found:              true,
        agreementId:        agreement.id,
        status:             agreement.status,
        totalInstallments:  agreement.totalInstallments,
        paidCount:          agreement.paidCount,
        installmentAmount:  Number(agreement.installmentAmount),
        currency:           agreement.currency,
      });
    }

    // Still PENDING_CHECKOUT — query VPS directly to check if card was charged
    const intent = agreement.initialPaymentIntent;
    const providerRef = intent?.providerRef;
    if (providerRef && intent) {
      try {
        const config = await prisma.providerConfig.findFirst({
          where: { tenantId: intent.tenantId, provider: 'VPS', status: 'CONNECTED' },
        });
        if (config) {
          const adapter      = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
          const queryResult  = await adapter.queryTransactionStatus(providerRef);
          const raw          = queryResult.rawResponse as Record<string, unknown>;
          const rawVpsStatus = ((raw['status'] as string) ?? '').toUpperCase();

          // AUTHORISED — auto-settle, then activate agreement
          if (rawVpsStatus === 'AUTHORISED' || rawVpsStatus === 'AUTHORIZED') {
            const amountCentimes = Math.round(Number(agreement.installmentAmount) * 100);
            try {
              await adapter.capturePayment(providerRef, amountCentimes, agreement.currency);
            } catch (settleErr) {
              console.warn('[sim/bnpl] SETTLE failed, will retry on next poll:', settleErr);
              return res.json({ found: false });
            }
          }

          // CHARGED / SETTLED after auto-settle or if it came in already CHARGED
          if (
            rawVpsStatus === 'CHARGED' ||
            rawVpsStatus === 'CAPTURED' ||
            rawVpsStatus === 'PAID'    ||
            rawVpsStatus === 'SETTLED' ||
            rawVpsStatus === 'AUTHORISED' || // fallthrough from successful settle
            rawVpsStatus === 'AUTHORIZED'
          ) {
            // storedPaymentProfileId won't be in the query response (it comes via
            // webhook), so we use a sandbox sentinel and mark the agreement ACTIVE
            // so the simulation can proceed.
            const SANDBOX_PROFILE = `SANDBOX_PROFILE_${providerRef.slice(0, 8)}`;
            const { encrypt } = await import('../lib/encryption');
            const encryptedProfileId = encrypt(SANDBOX_PROFILE);

            const nextChargeDate = new Date();
            nextChargeDate.setUTCMonth(nextChargeDate.getUTCMonth() + 1);

            await prisma.$transaction([
              prisma.paymentIntent.update({
                where: { id: intent.id },
                data:  { status: 'SUCCEEDED' },
              }),
              prisma.installmentAgreement.update({
                where: { id: agreement.id },
                data: {
                  encryptedStoredProfileId: encryptedProfileId,
                  status:         'ACTIVE',
                  paidCount:      1,
                  nextChargeDate,
                },
              }),
              prisma.installmentCharge.create({
                data: {
                  agreementId:       agreement.id,
                  installmentNumber: 1,
                  dueDate:           new Date(),
                  amount:            agreement.downPayment,
                  currency:          agreement.currency,
                  status:            'CHARGED',
                  chargeId:          `down-${agreement.id}`,
                  attemptNumber:     1,
                  processedAt:       new Date(),
                },
              }),
            ]);

            return res.json({
              found:              true,
              agreementId:        agreement.id,
              status:             'ACTIVE',
              totalInstallments:  agreement.totalInstallments,
              paidCount:          1,
              installmentAmount:  Number(agreement.installmentAmount),
              currency:           agreement.currency,
            });
          }

          // REDIRECTED — 3DS needed; return paymentServiceUrl for the frontend
          if (rawVpsStatus === 'REDIRECTED' || rawVpsStatus === 'AUTHORIZE_PENDING') {
            const paymentOption   = raw['paymentOption'] as Record<string, unknown> | undefined;
            const paymentServiceUrl =
              (paymentOption?.['paymentServiceURL'] as string | undefined) ??
              (paymentOption?.['paymentServiceUrl'] as string | undefined) ??
              null;
            return res.json({ found: false, paymentServiceUrl });
          }
        }
      } catch {
        // VPS query error — fall through to found:false
      }
    }

    return res.json({ found: false });
  }),
);

// ── POST /admin/simulation/bnpl/fire ─────────────────────────────────────────

const BnplFireSchema = z.object({
  agreementId:  z.string().min(1),
  chargeDelay:  z.number().int().min(5).max(3600).default(30),
  retryDelay1:  z.number().int().min(5).max(3600).default(15),
  retryDelay2:  z.number().int().min(5).max(3600).default(30),
  retryDelay3:  z.number().int().min(5).max(3600).default(60),
});

router.post(
  '/bnpl/fire',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const body = BnplFireSchema.parse(req.body);
    const { agreementId, chargeDelay, retryDelay1, retryDelay2, retryDelay3 } = body;

    const agreement = await prisma.installmentAgreement.findUnique({
      where:   { id: agreementId },
      include: { plan: { select: { name: true } } },
    });
    if (!agreement) throw new AppError(404, 'AGREEMENT_NOT_FOUND', 'Installment agreement not found');
    if (!agreement.plan.name.startsWith(BNPL_SIM_PREFIX)) {
      throw new AppError(400, 'NOT_SIM_AGREEMENT', 'This agreement was not created by the simulator');
    }
    if (agreement.status !== 'ACTIVE') {
      throw new AppError(400, 'AGREEMENT_NOT_ACTIVE', `Agreement is in ${agreement.status} state — checkout must be completed first`);
    }
    if (!agreement.encryptedStoredProfileId) {
      throw new AppError(400, 'NO_PROFILE_ID', 'No payment profile stored — checkout must be completed first');
    }

    await inngest.send({
      name: 'billing/installment.simulation',
      data: {
        agreementId,
        tenantId:    agreement.tenantId,
        chargeDelay: toDelay(chargeDelay),
        retryDelay1: toDelay(retryDelay1),
        retryDelay2: toDelay(retryDelay2),
        retryDelay3: toDelay(retryDelay3),
      },
    });

    return res.json({
      agreementId,
      delays: {
        chargeDelay: toDelay(chargeDelay),
        retryDelay1: toDelay(retryDelay1),
        retryDelay2: toDelay(retryDelay2),
        retryDelay3: toDelay(retryDelay3),
      },
    });
  }),
);

// ── GET /admin/simulation/bnpl/status/:agreementId ───────────────────────────

router.get(
  '/bnpl/status/:agreementId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const agreement = await prisma.installmentAgreement.findUnique({
      where:   { id: req.params.agreementId },
      include: {
        installmentCharges: { orderBy: { installmentNumber: 'asc' } },
      },
    });
    if (!agreement) throw new AppError(404, 'AGREEMENT_NOT_FOUND', 'Agreement not found');

    const { encryptedStoredProfileId: _r, inngestRunId: _run, ...safeAgreement } = agreement;
    const done = ['COMPLETED', 'DEFAULTED', 'CANCELLED'].includes(agreement.status);

    return res.json({
      agreementId:        agreement.id,
      agreement:          {
        ...safeAgreement,
        principalAmount:   Number(safeAgreement.principalAmount),
        downPayment:       Number(safeAgreement.downPayment),
        installmentAmount: Number(safeAgreement.installmentAmount),
      },
      installmentCharges: agreement.installmentCharges,
      done,
    });
  }),
);

// ── DELETE /admin/simulation/bnpl/cleanup/:agreementId ───────────────────────

router.delete(
  '/bnpl/cleanup/:agreementId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { agreementId } = req.params;

    const agreement = await prisma.installmentAgreement.findUnique({
      where:   { id: agreementId },
      include: { plan: { select: { name: true, id: true } } },
    });

    if (!agreement) {
      return res.json({ deleted: { charges: 0, agreements: 0, paymentIntents: 0, paymentLinks: 0, plans: 0 } });
    }

    const charges  = await prisma.installmentCharge.deleteMany({ where: { agreementId } });
    const agrs     = await prisma.installmentAgreement.deleteMany({ where: { id: agreementId } });
    const intents  = await prisma.paymentIntent.deleteMany({ where: { id: agreement.initialPaymentIntentId } });

    let links  = { count: 0 };
    let plans  = { count: 0 };

    if (agreement.paymentLinkId) {
      links = await prisma.paymentLink.deleteMany({ where: { id: agreement.paymentLinkId } });
    }
    if (agreement.plan.name.startsWith(BNPL_SIM_PREFIX)) {
      plans = await prisma.installmentPlan.deleteMany({ where: { id: agreement.plan.id } });
    }

    return res.json({
      deleted: {
        charges:       charges.count,
        agreements:    agrs.count,
        paymentIntents: intents.count,
        paymentLinks:  links.count,
        plans:         plans.count,
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Direct Charge Simulation Routes  (no SPP — pure VPS smoke test)
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_SIM_PREFIX = '__DIRECT_SIM_';

// ── POST /admin/simulation/direct/prepare ────────────────────────────────────
//  Creates a throwaway PaymentLink + PaymentIntent and returns a signed PayWall
//  payload. No stored profiles, no pre-auth — straight CHARGE mode.

router.post(
  '/direct/prepare',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { tenantId, amount = 1.00 } = z.object({
      tenantId: z.string().min(1),
      amount:   z.number().positive().default(1.00),
    }).parse(req.body);

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) throw new AppError(400, 'NO_VPS_CONFIG', 'Tenant has no connected VPS provider config');

    const sessionTag = `${DIRECT_SIM_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const amountCentimes = Math.round(amount * 100);

    const link = await prisma.paymentLink.create({
      data: {
        tenantId,
        slug:        sessionTag,
        amount:      amountCentimes,
        currency:    'MAD',
        description: `Direct Charge Test — ${amount.toFixed(2)} MAD`,
        reference:   sessionTag,
        provider:    'VPS',
        status:      'ACTIVE',
        maxAttempts: 1,
      },
    });

    const correlationId = randomUUID().replace(/-/g, '');
    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId,
        paymentLinkId:  link.id,
        status:         'CREATED',
        provider:       'VPS',
        correlationId,
        metadata:       { directSim: true },
      },
    });

    const adapter = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
    const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

    const checkoutResult = await adapter.createCheckoutSession({
      amount:              amountCentimes,
      currency:            'MAD',
      reference:           sessionTag,
      description:         `Direct Charge Test — ${amount.toFixed(2)} MAD`,
      returnUrl:           `${webBase}/checkout/success`,
      successUrl:          `${webBase}/checkout/success`,
      failureUrl:          `${webBase}/checkout/failure`,
      webhookUrl:          `${apiBase}/webhooks/vps`,
      correlationId,
      isPreauth:           true,  // AUTHORIZE mode → triggers 3DS simulator in sandbox
      storePaymentProfile: false,
    });

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data:  { status: 'REQUIRES_ACTION', providerRef: checkoutResult.providerRef },
    });

    const pd = checkoutResult.providerData ?? {};

    return res.status(201).json({
      intentId:         intent.id,
      linkId:           link.id,
      sessionTag,
      paywallUrl:       pd['paywallUrl'] as string,
      paywallPayload:   pd['payload']    as string,
      paywallSignature: pd['signature']  as string,
      amount,
    });
  }),
);

// ── GET /admin/simulation/direct/status/:intentId ────────────────────────────
//
// Actively queries the VPS API on every poll so the simulation works in
// local-dev where the webhook callbackUrl (localhost) is unreachable by VPS.
//
// VPS post-PayWall status handling:
//
//  REDIRECTED / AUTHORIZE_PENDING
//    → 3DS required.  VPS includes paymentOption.paymentServiceURL in the
//      query response.  We return this URL so the frontend can load it in
//      the inline iframe and let the customer complete the 3DS challenge.
//
//  AUTHORISED / AUTHORIZED
//    → Card authorized (pre-auth granted).  For a direct-charge simulation
//      (doFundsAuthOnly=false) the PayWall already completed 3DS but VPS
//      didn't auto-settle.  We call SETTLE immediately to finish the charge.
//
//  CHARGED / SUCCEEDED
//    → Payment complete.  Mark terminal and return.

router.get(
  '/direct/status/:intentId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: req.params.intentId },
      include: { paymentLink: { select: { amount: true, currency: true } } },
    });
    if (!intent) throw new AppError(404, 'NOT_FOUND', 'Intent not found');

    const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELED'];

    // Already terminal (e.g. webhook did arrive) — fast path
    if (TERMINAL.includes(intent.status)) {
      return res.json({
        intentId:    intent.id,
        status:      intent.status,
        providerRef: intent.providerRef,
        terminal:    true,
      });
    }

    if (!intent.providerRef) {
      return res.json({ intentId: intent.id, status: intent.status, providerRef: null, terminal: false });
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: intent.tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) {
      return res.json({ intentId: intent.id, status: intent.status, providerRef: intent.providerRef, terminal: false });
    }

    let rawVpsStatus = '';
    try {
      const adapter     = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
      const queryResult = await adapter.queryTransactionStatus(intent.providerRef);
      const raw         = queryResult.rawResponse as Record<string, unknown>;
      // Support both flat { status } and wrapped { charge: { status } } responses
      const chargeData  = (raw['charge'] as Record<string, unknown> | undefined) ?? raw;
      rawVpsStatus      = ((chargeData['status'] as string) ?? '').toUpperCase();

      console.log(`[sim/direct] VPS status for ${intent.providerRef}: ${rawVpsStatus}`, JSON.stringify({
        intentId: intent.id,
        rawResponse: raw,
      }, null, 2));

      // ── Case 1: 3DS redirect required ──────────────────────────────────────
      // VPS returns one of several 3DS intermediate states.  The
      // paymentServiceURL (if present) is where the customer completes the
      // challenge.  Many sandbox flows skip this entirely.
      const IS_3DS = [
        'REDIRECTED', 'AUTHORIZE_PENDING', 'AUTHORIZATION_PENDING',
        'CHALLENGE_REQUIRED', 'CHALLENGED', 'PENDING_3DS', 'THREE_DS_PENDING',
      ].includes(rawVpsStatus);

      if (IS_3DS) {
        const paymentOption = raw['paymentOption'] as Record<string, unknown> | undefined;
        const paymentServiceUrl =
          (paymentOption?.['paymentServiceURL'] as string | undefined) ??
          (paymentOption?.['paymentServiceUrl'] as string | undefined) ??
          null;

        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data:  { status: 'REQUIRES_ACTION' },
        });

        return res.json({
          intentId:          intent.id,
          status:            'REQUIRES_ACTION',
          providerRef:       intent.providerRef,
          terminal:          false,
          rawVpsStatus,
          paymentServiceUrl,
        });
      }

      // ── Case 2: Authorized (pre-auth) — auto-SETTLE for direct charge ───────
      // The PayWall authorized the card but VPS didn't auto-capture.
      // Call SETTLE immediately to convert AUTHORISED → CHARGED.
      const IS_AUTHORISED = [
        'AUTHORISED', 'AUTHORIZED', 'AUTHORIZATION', 'PREAUTHORIZED', 'PRE_AUTHORIZED',
      ].includes(rawVpsStatus);

      if (IS_AUTHORISED) {
        const amountCentimes = intent.paymentLink?.amount
          ? Math.round(Number(intent.paymentLink.amount))
          : 100;
        const currency = intent.paymentLink?.currency ?? 'MAD';

        console.log(`[sim/direct] Attempting SETTLE for ${intent.providerRef}, amount=${amountCentimes} centimes`);
        try {
          await adapter.capturePayment(intent.providerRef, amountCentimes, currency);
          await prisma.paymentIntent.update({
            where: { id: intent.id },
            data:  { status: 'SUCCEEDED' },
          });
          return res.json({
            intentId:     intent.id,
            status:       'SUCCEEDED',
            providerRef:  intent.providerRef,
            terminal:     true,
            rawVpsStatus,
          });
        } catch (settleErr) {
          const msg = (settleErr as Error).message;
          console.error(`[sim/direct] SETTLE failed for ${intent.providerRef}:`, msg);
          return res.json({
            intentId:     intent.id,
            status:       'REQUIRES_ACTION',
            providerRef:  intent.providerRef,
            terminal:     false,
            rawVpsStatus,
            settleError:  msg,
          });
        }
      }

      // ── Case 3: Terminal / in-flight — update DB and return ─────────────────
      const liveStatus = queryResult.status;
      if (liveStatus !== intent.status) {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data:  { status: liveStatus },
        });
      }
      return res.json({
        intentId:        intent.id,
        status:          liveStatus,
        providerRef:     intent.providerRef,
        terminal:        TERMINAL.includes(liveStatus),
        rawVpsStatus,
        vpsRawResponse:  rawVpsStatus === '' ? raw : undefined,
      });

    } catch (queryErr) {
      const msg = (queryErr as Error).message;
      // 404 = charge not yet created on VPS (customer still filling PayWall form) — expected, poll silently
      const is404 = msg.includes('HTTP 404') || msg.includes('entity_not_found');
      if (!is404) {
        console.error(`[sim/direct] VPS queryTransactionStatus failed for ${intent.providerRef}:`, msg);
      }
      return res.json({
        intentId:     intent.id,
        status:       intent.status,
        providerRef:  intent.providerRef,
        terminal:     false,
        rawVpsStatus: rawVpsStatus || null,
        ...(is404 ? {} : { queryError: msg }),
      });
    }
  }),
);

// ── DELETE /admin/simulation/direct/cleanup/:intentId ────────────────────────

router.delete(
  '/direct/cleanup/:intentId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: req.params.intentId },
      select: { id: true, paymentLinkId: true },
    });
    if (!intent) return res.json({ deleted: { intents: 0, links: 0 } });

    const intents = await prisma.paymentIntent.deleteMany({ where: { id: intent.id } });
    const links   = intent.paymentLinkId
      ? await prisma.paymentLink.deleteMany({ where: { id: intent.paymentLinkId } })
      : { count: 0 };

    return res.json({ deleted: { intents: intents.count, links: links.count } });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Pre-Auth Simulation Routes  (AUTHORIZE → manual SETTLE or AUTH_REVERSAL)
// ─────────────────────────────────────────────────────────────────────────────

const PREAUTH_SIM_PREFIX = '__PREAUTH_SIM_';

// ── POST /admin/simulation/preauth/prepare ────────────────────────────────────
// Creates a PaymentIntent + PayWall payload in AUTHORIZE mode.
// Returns a signed PayWall form — same as direct/prepare but doFundsAuthOnly=true
// is the intended semantic (no auto-settle in the status poller).

router.post(
  '/preauth/prepare',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { tenantId, amount = 1.00 } = z.object({
      tenantId: z.string().min(1),
      amount:   z.number().positive().default(1.00),
    }).parse(req.body);

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) throw new AppError(400, 'NO_VPS_CONFIG', 'Tenant has no connected VPS provider config');

    const sessionTag     = `${PREAUTH_SIM_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const amountCentimes = Math.round(amount * 100);

    const link = await prisma.paymentLink.create({
      data: {
        tenantId,
        slug:        sessionTag,
        amount:      amountCentimes,
        currency:    'MAD',
        description: `Pre-Auth Test — ${amount.toFixed(2)} MAD`,
        reference:   sessionTag,
        provider:    'VPS',
        status:      'ACTIVE',
        maxAttempts: 1,
      },
    });

    const correlationId = randomUUID().replace(/-/g, '');
    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId,
        paymentLinkId:  link.id,
        status:         'CREATED',
        provider:       'VPS',
        correlationId,
        metadata:       { preauthSim: true },
      },
    });

    const adapter = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
    const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

    const checkoutResult = await adapter.createCheckoutSession({
      amount:              amountCentimes,
      currency:            'MAD',
      reference:           sessionTag,
      description:         `Pre-Auth Test — ${amount.toFixed(2)} MAD`,
      returnUrl:           `${webBase}/checkout/success`,
      successUrl:          `${webBase}/checkout/success`,
      failureUrl:          `${webBase}/checkout/failure`,
      webhookUrl:          `${apiBase}/webhooks/vps`,
      correlationId,
      isPreauth:           true,   // AUTHORIZE mode — funds held, no capture
      storePaymentProfile: false,
    });

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data:  { status: 'REQUIRES_ACTION', providerRef: checkoutResult.providerRef },
    });

    const pd = checkoutResult.providerData ?? {};

    return res.status(201).json({
      intentId:         intent.id,
      linkId:           link.id,
      sessionTag,
      paywallUrl:       pd['paywallUrl'] as string,
      paywallPayload:   pd['payload']    as string,
      paywallSignature: pd['signature']  as string,
      amount,
    });
  }),
);

// ── GET /admin/simulation/preauth/status/:intentId ────────────────────────────
// Like direct/status but does NOT auto-settle when AUTHORISED.
// Returns { authorized: true } so the UI can show manual Capture / Release buttons.

router.get(
  '/preauth/status/:intentId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where:   { id: req.params.intentId },
      include: { paymentLink: { select: { amount: true, currency: true } } },
    });
    if (!intent) throw new AppError(404, 'NOT_FOUND', 'Intent not found');

    const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELED'];

    if (TERMINAL.includes(intent.status)) {
      return res.json({
        intentId:   intent.id,
        status:     intent.status,
        providerRef: intent.providerRef,
        terminal:   true,
        authorized: false,
      });
    }

    if (!intent.providerRef) {
      return res.json({
        intentId:   intent.id,
        status:     intent.status,
        providerRef: null,
        terminal:   false,
        authorized: false,
      });
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: intent.tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) {
      return res.json({
        intentId:   intent.id,
        status:     intent.status,
        providerRef: intent.providerRef,
        terminal:   false,
        authorized: false,
      });
    }

    try {
      const adapter      = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
      const queryResult  = await adapter.queryTransactionStatus(intent.providerRef);
      const raw          = queryResult.rawResponse as Record<string, unknown>;
      const chargeData   = (raw['charge'] as Record<string, unknown> | undefined) ?? raw;
      const rawVpsStatus = ((chargeData['status'] as string) ?? '').toUpperCase();

      console.log(`[sim/preauth] VPS status for ${intent.providerRef}: ${rawVpsStatus}`);

      // 3DS redirect — return paymentServiceUrl so iframe can navigate there
      const IS_3DS = [
        'REDIRECTED', 'AUTHORIZE_PENDING', 'AUTHORIZATION_PENDING',
        'CHALLENGE_REQUIRED', 'CHALLENGED', 'PENDING_3DS', 'THREE_DS_PENDING',
      ].includes(rawVpsStatus);

      if (IS_3DS) {
        const paymentOption = raw['paymentOption'] as Record<string, unknown> | undefined;
        const paymentServiceUrl =
          (paymentOption?.['paymentServiceURL'] as string | undefined) ??
          (paymentOption?.['paymentServiceUrl'] as string | undefined) ??
          null;

        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data:  { status: 'REQUIRES_ACTION' },
        });

        return res.json({
          intentId:          intent.id,
          status:            'REQUIRES_ACTION',
          providerRef:       intent.providerRef,
          terminal:          false,
          authorized:        false,
          paymentServiceUrl,
          rawVpsStatus,
        });
      }

      // AUTHORISED — funds held.
      // KEY DIFFERENCE from direct/status: we do NOT auto-settle here.
      // Return authorized:true so the UI shows manual Capture / Release buttons.
      const IS_AUTHORISED = [
        'AUTHORISED', 'AUTHORIZED', 'AUTHORIZATION', 'PREAUTHORIZED', 'PRE_AUTHORIZED',
      ].includes(rawVpsStatus);

      if (IS_AUTHORISED) {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data:  { status: 'REQUIRES_ACTION' },
        });

        return res.json({
          intentId:    intent.id,
          status:      'REQUIRES_ACTION',
          providerRef: intent.providerRef,
          terminal:    false,
          authorized:  true,
          rawVpsStatus,
        });
      }

      // Terminal / other in-flight states
      const liveStatus = queryResult.status;
      if (liveStatus !== intent.status) {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data:  { status: liveStatus },
        });
      }

      return res.json({
        intentId:    intent.id,
        status:      liveStatus,
        providerRef: intent.providerRef,
        terminal:    TERMINAL.includes(liveStatus),
        authorized:  false,
        rawVpsStatus,
      });
    } catch (queryErr) {
      const msg   = (queryErr as Error).message;
      const is404 = msg.includes('HTTP 404') || msg.includes('entity_not_found');
      if (!is404) {
        console.error(`[sim/preauth] VPS queryTransactionStatus failed for ${intent.providerRef}:`, msg);
      }
      return res.json({
        intentId:    intent.id,
        status:      intent.status,
        providerRef: intent.providerRef,
        terminal:    false,
        authorized:  false,
        ...(is404 ? {} : { queryError: msg }),
      });
    }
  }),
);

// ── POST /admin/simulation/preauth/capture/:intentId ─────────────────────────
// Manually SETTLE a pre-authorised charge (convert hold to capture).

router.post(
  '/preauth/capture/:intentId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where:   { id: req.params.intentId },
      include: { paymentLink: { select: { amount: true, currency: true } } },
    });
    if (!intent) throw new AppError(404, 'NOT_FOUND', 'Intent not found');
    if (intent.status !== 'REQUIRES_ACTION') {
      throw new AppError(400, 'WRONG_STATE', `Intent is ${intent.status}, expected REQUIRES_ACTION`);
    }
    if (!intent.providerRef) {
      throw new AppError(400, 'NO_PROVIDER_REF', 'No providerRef — PayWall has not been completed');
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: intent.tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) throw new AppError(400, 'NO_VPS_CONFIG', 'VPS config not found');

    const amountCentimes = intent.paymentLink?.amount
      ? Math.round(Number(intent.paymentLink.amount))
      : 100;
    const currency = intent.paymentLink?.currency ?? 'MAD';

    const adapter = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
    await adapter.capturePayment(intent.providerRef, amountCentimes, currency);

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data:  { status: 'SUCCEEDED' },
    });

    await inngest.send({
      name: 'payment/captured',
      data: { intentId: intent.id, tenantId: intent.tenantId },
    });

    return res.json({ intentId: intent.id, status: 'SUCCEEDED' });
  }),
);

// ── POST /admin/simulation/preauth/cancel/:intentId ───────────────────────────
// AUTH_REVERSAL — release the held funds back to the customer.

router.post(
  '/preauth/cancel/:intentId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where:   { id: req.params.intentId },
      include: { paymentLink: { select: { amount: true, currency: true } } },
    });
    if (!intent) throw new AppError(404, 'NOT_FOUND', 'Intent not found');
    if (intent.status !== 'REQUIRES_ACTION') {
      throw new AppError(400, 'WRONG_STATE', `Intent is ${intent.status}, expected REQUIRES_ACTION`);
    }
    if (!intent.providerRef) {
      throw new AppError(400, 'NO_PROVIDER_REF', 'No providerRef — PayWall has not been completed');
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: intent.tenantId, provider: 'VPS', status: 'CONNECTED' },
    });
    if (!config) throw new AppError(400, 'NO_VPS_CONFIG', 'VPS config not found');

    const amountCentimes = intent.paymentLink?.amount
      ? Math.round(Number(intent.paymentLink.amount))
      : 100;
    const currency = intent.paymentLink?.currency ?? 'MAD';

    const adapter = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
    await adapter.cancelPayment(intent.providerRef, amountCentimes, currency);

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data:  { status: 'CANCELED' },
    });

    await inngest.send({
      name: 'payment/canceled',
      data: { intentId: intent.id, tenantId: intent.tenantId },
    });

    return res.json({ intentId: intent.id, status: 'CANCELED' });
  }),
);

// ── DELETE /admin/simulation/preauth/cleanup/:intentId ────────────────────────

router.delete(
  '/preauth/cleanup/:intentId',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where:  { id: req.params.intentId },
      select: { id: true, paymentLinkId: true },
    });
    if (!intent) return res.json({ deleted: { intents: 0, links: 0 } });

    const intents = await prisma.paymentIntent.deleteMany({ where: { id: intent.id } });
    const links   = intent.paymentLinkId
      ? await prisma.paymentLink.deleteMany({ where: { id: intent.paymentLinkId } })
      : { count: 0 };

    return res.json({ deleted: { intents: intents.count, links: links.count } });
  }),
);

export default router;
