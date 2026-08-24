/**
 * Merchant POST /payment-intents              – create a payment intent directly (no Payment Link required)
 * Merchant GET  /payment-intents/:id          – get intent detail
 * Merchant GET  /payment-intents/:id/status   – poll latest status from provider
 * Merchant POST /payment-intents/:id/capture  – capture a pre-authorised payment (VPS only)
 * Merchant POST /payment-intents/:id/cancel   – void/cancel a pre-authorised payment (VPS only)
 * Public   POST /public/checkout/:slug/pay    – creates a PaymentIntent from a Payment Link and redirects
 */
import { Router } from "express";
import { createIntentSchema, paySchema } from "../schemas/payment-intents";
import { Provider } from "@/generated/prisma/client";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { inngest } from "../lib/inngest";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import { trackMetric } from "../lib/metrics";
import { getAdapter } from "../adapters/registry";
import { maskObject } from "../lib/mask";
import { computeInstallmentAmount } from "../lib/billing";

// ─── Merchant router ─────────────────────────────────────────────────────────────

const router = Router();

// ── POST /payment-intents — direct programmatic creation ──────────────────────────
//
// Intended for B2B tenants (e.g. acme) that initiate payments from their
// backend via API key, without a hosted Payment Link page.

// Payzone validates customerLocale on its paywall initialize endpoint and
// rejects anything outside this list with a 400 — which silently kills the
// paywall UI (renders without the card entry form). Normalize instead of
// passing invalid values through; the VPS adapter then falls back to "en_US".
const SUPPORTED_LOCALES = new Set([
  "en_US",
  "fr_FR",
  "pt_BR",
  "ar_EG",
  "da_DK",
  "de_DE",
  "es_ES",
  "fi_FI",
  "it_IT",
  "ja_JP",
  "ko_KR",
  "nl_NL",
  "no_NO",
  "pl_PL",
  "ru_RU",
  "sv_SE",
  "tr_TR",
]);

router.post(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const body = createIntentSchema.parse(req.body);

    // M-7: Payzone 400s on invalid customerLocale and the paywall never
    // renders — drop invalid values so the adapter default (en_US) is used.
    const customerLocale =
      body.customerLocale && SUPPORTED_LOCALES.has(body.customerLocale)
        ? body.customerLocale
        : undefined;

    const db = forTenant(req.user!.tenantId);
    const config = await db.providerConfig.findFirst({
      where: {
        provider: body.provider,
      },
    });
    if (!config || config.status !== "CONNECTED") {
      const reason =
        config?.status === "DISABLED"
          ? `Provider ${body.provider} is disabled`
          : `Provider ${body.provider} is not configured or not connected`;
      throw new AppError(503, "PROVIDER_UNAVAILABLE", reason);
    }

    // ── Idempotency: deduplicate by reference within 5 min ───────────────────────
    // Acme (and other API clients) sometimes call this endpoint twice in quick
    // succession for the same booking. If a non-terminal intent with the same
    // reference was created within the last 5 minutes, return it as-is instead of
    // creating a duplicate.
    // 5 min is intentionally short: Payzone paywall sessions expire after ~15 min,
    // so we must not return a cached intent with a stale paywall timestamp beyond
    // that window. 5 min is still long enough to catch rapid double-submit races.
    //
    // IMPORTANT: walletMode is part of the idempotency key.
    // A Checkout Session intent (walletMode=undefined) and a PaymentIntent
    // (walletMode='apple_pay'|'google_pay') are structurally different responses —
    // a cached Checkout Session must never be returned for a wallet request and
    // vice versa. We discriminate by checking whether the stored providerData
    // contains a clientSecret (wallet) or a sessionId (hosted checkout).
    const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"] as const;
    const isWalletRequest = body.walletMode === "apple_pay" || body.walletMode === "google_pay";
    const existing = await db.paymentIntent.findFirst({
      where: {
        status: { notIn: TERMINAL as any },
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        metadata: { path: ["reference"], equals: body.reference },
      },
      orderBy: { createdAt: "desc" },
    });

    // If the stored intent is the wrong "mode" (wallet vs hosted checkout),
    // ignore the cache and fall through to create a fresh intent.
    const existingIsWallet = (() => {
      if (!existing) return false;
      const pd = (existing.providerData as Record<string, unknown> | null) ?? {};
      return typeof pd["clientSecret"] === "string" && !!pd["clientSecret"];
    })();
    const modeMismatch = existing && isWalletRequest !== existingIsWallet;

    if (existing && !modeMismatch) {
      const apiBase = process.env.API_BASE_URL ?? "http://localhost:4000";
      // Re-surface the top-level redirectUrl from providerData so Stripe
      // callers (Acme) can use it directly without diving into providerData.
      // The original 201 response sets redirectUrl at the top level, but the
      // idempotent 200 path was missing it — causing Acme to fall back to
      // the CorpoPay relay page URL instead of the direct Stripe checkout URL.
      const existingPd = (existing.providerData as Record<string, unknown> | null) ?? null;
      const existingRedirectUrl = (existingPd?.["redirectUrl"] as string | undefined) ?? null;

      // Re-surface stripeData for wallet flows (apple_pay / google_pay).
      // The 201 path populates stripeData from the adapter result, but the
      // idempotent 200 path was returning null — causing the frontend to show
      // "Payment session could not be started" on every retry within 5 min.
      // clientSecret and publishableKey are stored inside providerData by the
      // Stripe adapter, so we reconstruct stripeData from there.
      const existingClientSecret = (existingPd?.["clientSecret"] as string | undefined) ?? null;
      const existingPublishableKey = (existingPd?.["publishableKey"] as string | undefined) ?? null;
      const existingStripeData =
        existingClientSecret && existingPublishableKey
          ? {
              clientSecret: existingClientSecret,
              publishableKey: existingPublishableKey,
            }
          : null;

      return res.status(200).json({
        intentId: existing.id,
        correlationId: existing.correlationId,
        checkoutUrl: `${apiBase}/public/pay/${existing.correlationId}`,
        redirectUrl: existingRedirectUrl,
        providerData: existingPd,
        stripeData: existingStripeData,
        idempotent: true,
      });
    }

    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId: req.user!.tenantId,
        provider: body.provider,
        status: "CREATED",
        metadata: (body.metadata as any) ?? null,
        // paymentLinkId intentionally null — direct intent
      },
    });

    const adapter = getAdapter(body.provider, config.encryptedCredentials);
    const apiBase = process.env.API_BASE_URL ?? "http://localhost:4000";
    const callbackUrl = body.webhookUrl ?? `${apiBase}/webhooks/${body.provider.toLowerCase()}`;

    const result = await adapter.createCheckoutSession({
      amount: body.amount,
      currency: body.currency,
      reference: body.reference,
      description: body.description,
      returnUrl: body.returnUrl,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      failureUrl: body.failureUrl,
      webhookUrl: callbackUrl,
      customerEmail: body.customerEmail,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      customerCountry: body.customerCountry,
      customerLocale,
      isPreauth: body.isPreauth,
      correlationId: intent.correlationId,
      walletMode: body.walletMode,
    });

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "REQUIRES_ACTION",
          providerRef: result.providerRef,
          // Always merge redirectUrl into providerData so the public relay page
          // can use it. For Stripe this is the stripe.com checkout session URL.
          // For VPS it will be the relay page URL (unused by relay page since
          // it has paywallUrl), but harmless to store.
          providerData: {
            ...(result.providerData ?? {}),
            ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
          } as any,
          // Persist amount + currency + reference + description in metadata so
          // the transactions list can surface them without a paymentLink join.
          metadata: {
            ...(body.metadata ?? {}),
            amount: body.amount,
            currency: body.currency,
            reference: body.reference,
            description: body.description,
          },
        },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider: body.provider,
          rawRequest: maskObject(result.rawRequest) as any,
          rawResponse: maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: "payment/poll-status",
      data: {
        intentId: intent.id,
        provider: body.provider,
        tenantId: req.user!.tenantId,
        providerRef: result.providerRef,
      },
    });

    trackMetric("corpopay.payment_intent.created", 1, [`provider:${body.provider}`]);

    return res.status(201).json({
      intentId: intent.id,
      correlationId: intent.correlationId,
      // checkoutUrl is the hosted relay page for VPS/Payzone.
      // For Stripe, redirectUrl is the direct Stripe-hosted checkout URL —
      // Acme should use redirectUrl when present, falling back to checkoutUrl.
      // For Stripe wallet flows, redirectUrl is empty and stripeData is populated.
      checkoutUrl: `${apiBase}/public/pay/${intent.correlationId}`,
      redirectUrl: result.redirectUrl || null,
      providerData: result.providerData ?? null,
      // Populated for Stripe wallet flows only (walletMode = apple_pay | google_pay).
      // Contains clientSecret + publishableKey for ExpressCheckoutElement.
      stripeData: result.stripeData ?? null,
    });
  }),
);

// ── GET /payment-intents/:id ───────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const intent = await db.paymentIntent.findFirst({
      where: { id: req.params.id },
      include: {
        paymentLink: {
          select: {
            slug: true,
            amount: true,
            currency: true,
            description: true,
            reference: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
          },
        },
        providerTxs: {
          select: {
            id: true,
            provider: true,
            providerTransactionId: true,
            rawResponse: true,
            createdAt: true,
          },
        },
        refunds: {
          select: { id: true, status: true, amount: true, createdAt: true },
        },
        webhookEvents: {
          select: {
            id: true,
            signatureVerified: true,
            processed: true,
            mappedStatus: true,
            createdAt: true,
          },
        },
      },
    });
    if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");
    res.json(intent);
  }),
);

// ── GET /payment-intents/:id/status ───────────────────────────────────────────

router.get(
  "/:id/status",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const intent = await db.paymentIntent.findFirst({
      where: { id: req.params.id },
      include: { paymentLink: true },
    });
    if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");

    // If already in a terminal state, return immediately
    const terminal = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"];
    if (terminal.includes(intent.status)) {
      return res.json({
        status: intent.status,
        providerRef: intent.providerRef,
      });
    }

    if (!intent.providerRef) {
      return res.json({ status: intent.status, providerRef: null });
    }

    const config = await db.providerConfig.findFirst({
      where: { provider: intent.provider },
    });
    if (!config) throw new AppError(400, "PROVIDER_NOT_CONFIGURED", "Provider config missing");

    const adapter = getAdapter(intent.provider, config.encryptedCredentials);

    let result: Awaited<ReturnType<typeof adapter.queryTransactionStatus>>;
    try {
      result = await adapter.queryTransactionStatus(intent.providerRef);
    } catch (err) {
      // Provider query failed (e.g. charge not yet committed to the provider, or
      // a transient upstream error). Return the last known DB status rather than
      // crashing — polling clients will retry and the status will resolve once
      // the customer completes the payment.
      console.warn("[GET /:id/status] queryTransactionStatus failed — returning DB status", {
        intentId: intent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.json({
        status: intent.status,
        providerRef: intent.providerRef,
      });
    }

    if (result.status !== intent.status) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: result.status },
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
  "/:id/capture",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    // C-1: Atomic status transition REQUIRES_ACTION → PROCESSING is the race-condition gate.
    // If two capture requests arrive simultaneously, only one updateMany returns count=1.
    const locked = await db.paymentIntent.updateMany({
      where: {
        id: req.params.id,
        status: "REQUIRES_ACTION",
      },
      data: { status: "PROCESSING" },
    });
    if (locked.count === 0) {
      // Either not found, wrong tenant, or already being processed / in terminal state
      const intent = await db.paymentIntent.findFirst({
        where: { id: req.params.id },
      });
      if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");
      throw new AppError(
        409,
        "INVALID_STATE",
        `Cannot capture intent in ${intent.status} state — may already be processing`,
      );
    }

    const intent = await db.paymentIntent.findFirst({
      where: { id: req.params.id },
      include: { paymentLink: true },
    });
    if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");

    if (!intent.providerRef) {
      // Revert the lock on unexpected bad state
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id },
        data: { status: "REQUIRES_ACTION" },
      });
      throw new AppError(
        400,
        "MISSING_PROVIDER_REF",
        "Intent has no provider reference to capture",
      );
    }

    const config = await db.providerConfig.findFirst({
      where: { provider: intent.provider },
    });
    if (!config) throw new AppError(400, "PROVIDER_NOT_CONFIGURED", "Provider config missing");

    const adapter = getAdapter(intent.provider, config.encryptedCredentials);

    // Resolve amount: from PaymentLink if linked, else from metadata (already centimes)
    const amount = intent.paymentLink
      ? Math.round(Number(intent.paymentLink.amount) * 100) // stored as MAD, convert to centimes
      : ((intent.metadata as any)?.amount as number | undefined); // already centimes
    const currency =
      intent.paymentLink?.currency ??
      ((intent.metadata as any)?.currency as string | undefined) ??
      "MAD";

    if (!amount) {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id },
        data: { status: "REQUIRES_ACTION" },
      });
      throw new AppError(400, "MISSING_AMOUNT", "Cannot determine amount to capture");
    }

    const result = await adapter.capturePayment(intent.providerRef, amount, currency);

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "SUCCEEDED" },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider: intent.provider,
          rawRequest: maskObject(result.rawRequest ?? {}) as any,
          rawResponse: maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: "payment/captured",
      data: { intentId: intent.id, tenantId: intent.tenantId },
    });

    res.json({ intentId: intent.id, status: "SUCCEEDED" });
  }),
);

// ── POST /payment-intents/:id/cancel ──────────────────────────────────────────
//
// Void/reverse a pre-authorised payment (AUTH_REVERSAL). Intent must be in
// REQUIRES_ACTION status.

router.post(
  "/:id/cancel",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    // C-1: Atomic status transition REQUIRES_ACTION → PROCESSING is the race-condition gate.
    const locked = await db.paymentIntent.updateMany({
      where: {
        id: req.params.id,
        status: "REQUIRES_ACTION",
      },
      data: { status: "PROCESSING" },
    });
    if (locked.count === 0) {
      const intent = await db.paymentIntent.findFirst({
        where: { id: req.params.id },
      });
      if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");
      throw new AppError(
        409,
        "INVALID_STATE",
        `Cannot cancel intent in ${intent.status} state — may already be processing`,
      );
    }

    const intent = await db.paymentIntent.findFirst({
      where: { id: req.params.id },
      include: { paymentLink: true },
    });
    if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment intent not found");

    if (!intent.providerRef) {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id },
        data: { status: "REQUIRES_ACTION" },
      });
      throw new AppError(400, "MISSING_PROVIDER_REF", "Intent has no provider reference to cancel");
    }

    const config = await db.providerConfig.findFirst({
      where: { provider: intent.provider },
    });
    if (!config) throw new AppError(400, "PROVIDER_NOT_CONFIGURED", "Provider config missing");

    const adapter = getAdapter(intent.provider, config.encryptedCredentials);
    // Resolve amount (already centimes from metadata, or MAD from PaymentLink → convert)
    const amount = intent.paymentLink
      ? Math.round(Number(intent.paymentLink.amount) * 100) // MAD → centimes
      : (((intent.metadata as any)?.amount as number | undefined) ?? 0); // already centimes
    const currency =
      intent.paymentLink?.currency ??
      ((intent.metadata as any)?.currency as string | undefined) ??
      "MAD";

    const result = await adapter.cancelPayment(intent.providerRef, amount, currency);

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "CANCELED" },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider: intent.provider,
          rawRequest: maskObject(result.rawRequest ?? {}) as any,
          rawResponse: maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: "payment/canceled",
      data: { intentId: intent.id, tenantId: intent.tenantId },
    });

    res.json({ intentId: intent.id, status: "CANCELED" });
  }),
);

export default router;

// ─── Public relay router ─────────────────────────────────────────────────────────
//
// GET /public/pay/:correlationId
//
// Serves the persisted providerData for the hosted relay page. Two render modes,
// selected by the request's Accept header:
//
//   • Browser (Accept: text/html) → returns an HTML page that auto-submits the
//     signed Payzone form, so opening checkoutUrl in ANY browser lands directly
//     on the Payzone paywall (no app or WebView required).
//   • API client (no text/html)   → returns JSON; the mobile app fetches this and
//     POSTs the form itself inside its own WebView.
//
// Security: correlationId is a 25-char CUID (~125-bit entropy) — safe to expose
// publicly. Terminal intents return status only (no providerData) so completed
// Payzone sessions cannot be replayed.

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPaywallHtml(pd: Record<string, unknown> | null): string {
  const paywallUrl = pd?.["paywallUrl"] as string | undefined;
  const payload = pd?.["payload"] as string | undefined;
  const signature = pd?.["signature"] as string | undefined;
  const mode = (pd?.["mode"] as string | undefined) ?? "DEEP_LINK";
  const redirectUrl = pd?.["redirectUrl"] as string | undefined;

  // VPS / Payzone — signed form POST to the hosted paywall.
  if (paywallUrl && payload && signature) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Secure Payment</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0a0e21; }
    iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe
    name="paywall-frame"
    title="Secure Payment"
  ></iframe>
  <form id="payzone" method="POST" action="${escapeHtml(paywallUrl)}" target="paywall-frame">
    <input type="hidden" name="payload" value="${escapeHtml(payload)}" />
    <input type="hidden" name="signature" value="${escapeHtml(signature)}" />
    <!-- mode is optional here: Payzone reads mode from inside the payload JSON.
         Keeping it as a top-level field is harmless. -->
    <input type="hidden" name="mode" value="${escapeHtml(mode)}" />
  </form>
  <script>
    (function () {
      var form = document.getElementById('payzone');
      var payload = form.querySelector('input[name="payload"]').value;
      try {
        var p = JSON.parse(payload);
        console.log('[corpopay-relay] POST', form.action,
          '| mode=' + p.mode,
          '| customerLocale=' + p.customerLocale,
          '| merchantAccount=' + p.merchantAccount);
      } catch (e) {
        console.log('[corpopay-relay] POST', form.action, '| payload unparseable');
      }
      form.submit();
    })();
  </script>
</body>
</html>`;
  }

  // Stripe / hosted redirect — navigate the browser directly.
  if (redirectUrl) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0; url=${escapeHtml(redirectUrl)}" />
</head>
<body style="font-family: system-ui, sans-serif; background:#0a0e21; color:#fff; text-align:center; padding:24px;">
  <p>Redirecting to secure payment&hellip;</p>
</body>
</html>`;
  }

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="font-family: system-ui, sans-serif; background:#0a0e21; color:#fff; text-align:center; padding:24px;">
  <p>This payment session is not available.</p>
</body>
</html>`;
}

/**
 * Resolve the browser-openable redirect URL for a just-created checkout.
 *
 * VPS / Payzone's `redirectUrl` is the bare `pwthree/launch` URL which requires
 * a signed form POST — a browser GET there is rejected ("unauthorized"). For
 * those intents we return our own HTML relay page (`/public/pay/:correlationId`)
 * which auto-submits the signed form. Stripe / other providers return a
 * GET-able hosted URL already, so we pass it through unchanged.
 */
function resolveBrowserRedirect(
  result: {
    redirectUrl: string;
    providerData?: Record<string, unknown> | null;
  },
  apiBase: string,
  correlationId: string,
): string {
  const pd = result.providerData as Record<string, unknown> | null | undefined;
  if (pd?.["paywallUrl"] && pd?.["payload"] && pd?.["signature"]) {
    return `${apiBase}/public/pay/${correlationId}`;
  }
  return result.redirectUrl;
}

export const publicRelayRouter = Router();

publicRelayRouter.get(
  "/:correlationId",
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where: { correlationId: req.params.correlationId },
      select: { status: true, providerData: true },
    });

    if (!intent) throw new AppError(404, "INTENT_NOT_FOUND", "Payment session not found");

    // Browsers send `Accept: text/html` for a top-level navigation; API clients
    // (Dio / axios) do not. This is the discriminator between the two modes.
    const accept = req.headers.accept ?? "";
    const wantsHtml = accept.includes("text/html");

    const terminal = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"];
    if (terminal.includes(intent.status)) {
      if (wantsHtml) return res.type("html").send(renderPaywallHtml(null));
      return res.json({ status: intent.status, providerData: null });
    }

    // H-10: Strip customer PII from the public relay response. The relay page only
    // needs paywallUrl/payload/signature/mode to submit the Payzone form, or
    // redirectUrl to navigate to the Stripe-hosted checkout page.
    // Customer name, email, phone are already embedded inside the signed payload
    // blob and must not be exposed separately as queryable plain fields.
    let safeProviderData: Record<string, unknown> | null = null;
    if (intent.providerData && typeof intent.providerData === "object") {
      const pd = intent.providerData as Record<string, unknown>;
      safeProviderData = {
        // VPS / Payzone fields
        paywallUrl: pd.paywallUrl,
        payload: pd.payload,
        signature: pd.signature,
        mode: pd.mode,
        chargeId: pd.chargeId,
        // Stripe fields — redirectUrl is the Stripe-hosted checkout session URL.
        // sessionId and publishableKey are not needed by the relay page.
        redirectUrl: pd.redirectUrl,
      };
    }

    if (wantsHtml) return res.type("html").send(renderPaywallHtml(safeProviderData));
    return res.json({ status: intent.status, providerData: safeProviderData });
  }),
);

// ─── Public router ────────────────────────────────────────────────────────────────

export const publicPayRouter = Router();

publicPayRouter.post(
  "/:slug/pay",
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where: { slug: req.params.slug },
      include: { tenant: { select: { id: true, status: true } } },
    });

    if (!link) throw new AppError(404, "LINK_NOT_FOUND", "Payment link not found");
    if (link.tenant.status === "DISABLED")
      throw new AppError(403, "TENANT_DISABLED", "Merchant not accepting payments");
    if (link.status !== "ACTIVE")
      throw new AppError(410, "LINK_INACTIVE", "This payment link is no longer active");
    if (link.expiresAt && link.expiresAt < new Date())
      throw new AppError(410, "LINK_EXPIRED", "Payment link expired");
    // H-2: Atomic increment + guard — prevents concurrent requests from bypassing maxAttempts.
    // updateMany returns count=0 if attemptCount already reached the limit.
    const bumped = await prisma.paymentLink.updateMany({
      where: { id: link.id, attemptCount: { lt: link.maxAttempts } },
      data: { attemptCount: { increment: 1 } },
    });
    if (bumped.count === 0)
      throw new AppError(429, "MAX_ATTEMPTS", "Maximum payment attempts reached");

    const { customerIp, customerEmail, customerName, installmentPlanId, downPaymentAmount } =
      paySchema.parse(req.body);

    const config = await prisma.providerConfig.findFirst({
      where: {
        tenantId: link.tenantId,
        provider: link.provider,
      },
    });
    if (!config || config.status !== "CONNECTED") {
      const reason =
        config?.status === "DISABLED"
          ? "Payment provider is disabled"
          : "Payment provider not available";
      throw new AppError(503, "PROVIDER_UNAVAILABLE", reason);
    }

    const adapter = getAdapter(link.provider, config.encryptedCredentials);

    const apiBase = process.env.API_BASE_URL ?? "http://localhost:4000";
    const webBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";

    // ── BNPL / Installment path ──────────────────────────────────────────────
    let installmentAgreementId: string | undefined;
    let chargeCentimes = Math.round(Number(link.amount) * 100); // default: full amount

    // M-5: if the link requires installments, a plan must always be provided
    if (link.isInstallment && !installmentPlanId) {
      throw new AppError(
        400,
        "PLAN_REQUIRED",
        "An installment plan must be selected for this payment link",
      );
    }

    if (installmentPlanId) {
      if (!link.isInstallment) {
        throw new AppError(
          400,
          "NOT_INSTALLMENT_LINK",
          "This payment link does not support installments",
        );
      }

      const plan = await prisma.installmentPlan.findFirst({
        where: {
          id: installmentPlanId,
          tenantId: link.tenantId,
          isActive: true,
        },
      });
      if (!plan)
        throw new AppError(404, "PLAN_NOT_FOUND", "Installment plan not found or not active");

      const principal = Number(link.amount);
      const apr = Number(plan.annualInterestRate);
      const n = plan.durationMonths;

      // Validate amount constraints
      if (plan.minAmount && principal < Number(plan.minAmount)) {
        throw new AppError(
          400,
          "AMOUNT_BELOW_MIN",
          `Minimum amount for this plan is ${plan.minAmount}`,
        );
      }
      if (plan.maxAmount && principal > Number(plan.maxAmount)) {
        throw new AppError(
          400,
          "AMOUNT_ABOVE_MAX",
          `Maximum amount for this plan is ${plan.maxAmount}`,
        );
      }

      const standardInstallment = computeInstallmentAmount(principal, apr, n);

      // H-7: Cap down payment at the full principal — cannot overcharge the customer.
      // Floor at one standard installment — cannot underpay.
      let downPayment = downPaymentAmount ?? standardInstallment;
      if (downPayment < standardInstallment) downPayment = standardInstallment;
      if (downPayment > principal) downPayment = principal; // H-7 cap
      downPayment = Math.round(downPayment * 100) / 100; // round to 2dp

      // Remaining installments after down payment
      const remainingPrincipal = Math.max(0, Math.round((principal - downPayment) * 100) / 100);
      const remainingInstallments = n - 1;
      const remainingMonthlyAmt =
        remainingInstallments > 0
          ? computeInstallmentAmount(remainingPrincipal, apr, remainingInstallments)
          : 0;
      const totalInstallments = 1 + (remainingInstallments > 0 ? remainingInstallments : 0);

      // Pre-create intent to get correlationId for the customerId
      const draftIntent = await prisma.paymentIntent.create({
        data: {
          tenantId: link.tenantId,
          paymentLinkId: link.id,
          provider: link.provider,
          customerIp: customerIp ?? req.ip ?? null,
          metadata: { bnpl: true }, // will be updated with agreementId below
        },
      });

      // Create InstallmentAgreement (PENDING_CHECKOUT)
      const agreement = await prisma.installmentAgreement.create({
        data: {
          tenantId: link.tenantId,
          customerId: draftIntent.correlationId,
          planId: plan.id,
          paymentLinkId: link.id,
          initialPaymentIntentId: draftIntent.id,
          principalAmount: principal,
          downPayment,
          installmentAmount: remainingMonthlyAmt > 0 ? remainingMonthlyAmt : downPayment,
          totalInstallments,
          currency: link.currency,
        },
      });

      // Tag the intent with the agreement ID so the webhook processor can find it
      await prisma.paymentIntent.update({
        where: { id: draftIntent.id },
        data: {
          metadata: { bnpl: true, installmentAgreementId: agreement.id },
        },
      });

      // Charge the down payment amount (in centimes)
      chargeCentimes = Math.round(downPayment * 100);
      installmentAgreementId = agreement.id;

      const result = await adapter.createCheckoutSession({
        amount: chargeCentimes,
        currency: link.currency,
        reference: link.reference,
        description: `${link.description} — Installment Plan (${n} months)`,
        returnUrl: `${webBase}/checkout/${link.slug}/result?intentId=${draftIntent.id}`,
        webhookUrl: `${apiBase}/webhooks/${link.provider.toLowerCase()}`,
        customerEmail: customerEmail ?? link.customerEmail ?? undefined,
        customerName: customerName ?? link.customerName ?? undefined,
        customerPhone: link.customerPhone ?? undefined,
        correlationId: draftIntent.correlationId,
        storePaymentProfile: true,
      });

      await prisma.$transaction([
        prisma.paymentIntent.update({
          where: { id: draftIntent.id },
          data: {
            status: "REQUIRES_ACTION",
            providerRef: result.providerRef,
            providerData: {
              ...(result.providerData ?? {}),
              ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
            } as any,
          },
        }),
        prisma.providerTransaction.create({
          data: {
            paymentIntentId: draftIntent.id,
            provider: link.provider,
            rawRequest: maskObject(result.rawRequest) as any,
            rawResponse: maskObject(result.rawResponse) as any,
          },
        }),
      ]);

      await inngest.send({
        name: "payment/poll-status",
        data: {
          intentId: draftIntent.id,
          provider: link.provider,
          tenantId: link.tenantId,
          providerRef: result.providerRef,
        },
      });

      return res.json({
        intentId: draftIntent.id,
        agreementId: agreement.id,
        redirectUrl: resolveBrowserRedirect(result, apiBase, draftIntent.correlationId),
        providerData: result.providerData ?? null,
      });
    }

    // ── Standard (non-installment) path ─────────────────────────────────────

    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId: link.tenantId,
        paymentLinkId: link.id,
        provider: link.provider,
        customerIp: customerIp ?? req.ip ?? null,
      },
    });

    const result = await adapter.createCheckoutSession({
      amount: chargeCentimes,
      currency: link.currency,
      reference: link.reference,
      description: link.description,
      returnUrl: `${webBase}/checkout/${link.slug}/result?intentId=${intent.id}`,
      webhookUrl: `${apiBase}/webhooks/${link.provider.toLowerCase()}`,
      customerEmail: customerEmail ?? link.customerEmail ?? undefined,
      customerName: customerName ?? link.customerName ?? undefined,
      customerPhone: link.customerPhone ?? undefined,
      correlationId: intent.correlationId,
      storePaymentProfile: link.isRecurring === true,
    });

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "REQUIRES_ACTION",
          providerRef: result.providerRef,
          providerData: {
            ...(result.providerData ?? {}),
            ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
          } as any,
        },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider: link.provider,
          rawRequest: maskObject(result.rawRequest) as any,
          rawResponse: maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    await inngest.send({
      name: "payment/poll-status",
      data: {
        intentId: intent.id,
        provider: link.provider,
        tenantId: link.tenantId,
        providerRef: result.providerRef,
      },
    });

    return res.json({
      intentId: intent.id,
      redirectUrl: resolveBrowserRedirect(result, apiBase, intent.correlationId),
      providerData: result.providerData ?? null,
    });
  }),
);
