/**
 * seed-sandbox.ts — powerful, deterministic, idempotent sandbox seeder.
 *
 * Builds a realistic **multi-tenant** sandbox dataset so local dev, demos and
 * end-to-end tests share one rich, reproducible fixture set:
 *
 *   - `demo`       — the hand-crafted Demo Merchant graph (reused from seed-demo.ts)
 *   - `otoparking` — a parking operator (one-time parking sessions, monthly
 *                    parking-pass subscriptions, annual-pass installments)
 *   - `jabadoor`   — a generic retail/access merchant (different amounts/refs)
 *
 * Every tenant exercises the full lifecycle: users (RBAC), provider configs
 * (VPS/Stripe/NAPS), payment links (one-time / recurring / installment / expired /
 * cancelled / paid), payment intents (every status), provider transactions,
 * refunds (partial + full), subscriptions (active / past_due / cancelled) with
 * billing events, installment plans + agreement + charges, API keys (active +
 * revoked) and webhook events (verified / unverified / duplicate).
 *
 * Deterministic: no `Math.random()`, no `Date.now()`, no crypto randomness in
 * IDs — every id/slug/correlationId is derived from the tenant slug, and all
 * timestamps are fixed offsets from 2026-01-01. Idempotent: every row is
 * upserted by a stable unique key, so re-running never duplicates and never
 * clobbers data you may have edited.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… npx tsx prisma/seed-sandbox.ts
 *   # or:  npm run db:seed:sandbox
 *
 * Requires ENCRYPTION_KEY (64 hex chars) — same contract as prisma/seed.ts and
 * prisma/seed-demo.ts.
 */

import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
  BillingInterval,
  Environment,
  InstallmentAgreementStatus,
  PaymentIntentStatus,
  PaymentLinkStatus,
  Prisma,
  PrismaClient,
  type PrismaClient as PrismaClientType,
  Provider,
  ProviderConfigStatus,
  RefundStatus,
  SubscriptionStatus,
  UserRole,
} from "../src/generated/prisma/client";
import { encrypt, encryptCredentials } from "../src/lib/encryption";
import { seedDemoData } from "./seed-demo";
import { DEMO_TENANT_ID } from "./seed-demo-data";

// ─── Deterministic timeline ────────────────────────────────────────────────────
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00.000Z

/** Fixed date `dayOffset` days (and `hourOffset` hours) after the base. */
function d(dayOffset: number, hourOffset = 0): Date {
  return new Date(BASE_MS + dayOffset * 86_400_000 + hourOffset * 3_600_000);
}

// ─── Tenant themes ─────────────────────────────────────────────────────────────
interface Theme {
  name: string;
  slug: string;
  domain: string;
  /** Reference prefix for payment links (e.g. "OTP" → "OTP-ONETIME"). */
  prefix: string;
  /** One-time payment amount (MAD). */
  oneTime: number;
  /** Recurring subscription amount (MAD). */
  recurring: number;
  /** BNPL principal amount (MAD) for the 3-month installment agreement. */
  installmentPrincipal: number;
}

/** Every tenant id produced by this seeder (demo + themes) — used by reset-sandbox.ts. */
export const SANDBOX_TENANT_IDS = [DEMO_TENANT_ID, ...["otoparking", "jabadoor"]];

const THEMES: Theme[] = [
  {
    name: "OtoParking",
    slug: "otoparking",
    domain: "otoparking.ma",
    prefix: "OTP",
    oneTime: 20,
    recurring: 400,
    installmentPrincipal: 4800,
  },
  {
    name: "JabaDoor",
    slug: "jabadoor",
    domain: "jabadoor.ma",
    prefix: "JBD",
    oneTime: 150,
    recurring: 250,
    installmentPrincipal: 3000,
  },
];

const APRS: Array<[number, number]> = [
  [3, 8.99],
  [6, 12.99],
  [12, 18.99],
];

// Centime amount for a MAD value (metadata.amount is centimes at the API boundary).
function cents(madAmount: number): number {
  return Math.round(madAmount * 100);
}

/**
 * Materialise one tenant theme. Safe to call repeatedly (idempotent upserts).
 */
async function seedTenant(prisma: PrismaClientType, theme: Theme): Promise<void> {
  const tenantId = theme.slug;

  // ── Tenant ────────────────────────────────────────────────────────────────
  await prisma.tenant.upsert({
    where: { slug: theme.slug },
    create: {
      id: tenantId,
      name: theme.name,
      slug: theme.slug,
      status: "ACTIVE",
      environment: Environment.SANDBOX,
      notifyEmail: `billing@${theme.domain}`,
      notifyWebhookUrl: null,
      createdAt: d(0),
    },
    update: { name: theme.name, environment: Environment.SANDBOX },
  });

  // ── Users (RBAC: owner, staff, super-admin) ───────────────────────────────
  const users = [
    { id: `${tenantId}-user-owner`, email: `owner@${theme.domain}`, role: UserRole.OWNER },
    { id: `${tenantId}-user-staff`, email: `staff@${theme.domain}`, role: UserRole.STAFF },
    { id: `${tenantId}-user-admin`, email: `admin@${theme.domain}`, role: UserRole.SUPER_ADMIN },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: u.email } },
      create: {
        id: u.id,
        tenantId,
        email: u.email,
        passwordHash: await bcrypt.hash("SandboxPass123!", 12),
        role: u.role,
      },
      update: {},
    });
  }

  // ── Provider configs (VPS / Stripe / NAPS — fake SANDBOX creds) ───────────
  const providerSpecs = [
    {
      id: `${tenantId}-provider-vps`,
      provider: Provider.VPS,
      credentials: {
        merchantAccount: `Int_${theme.slug}_Test`,
        paywallSecretKey: `${theme.slug}-paywall-secret`,
        paywallUrl: "https://payment-sandbox.payzone.ma/pwthree/launch",
        skin: "vps-1-vue",
        mode: "DEEP_LINK",
        showPaymentProfiles: "false",
        apiUrl: "https://payment-sandbox.payzone.ma",
        callerName: "$apicaller",
        callerPassword: `${theme.slug}-caller-password`,
        notificationKey: `${theme.slug}-notification-key`,
        callbackTestMode: true,
      },
    },
    {
      id: `${tenantId}-provider-stripe`,
      provider: Provider.STRIPE,
      credentials: {
        secretKey: `${theme.slug}-stripe-secret-key`,
        webhookSecret: `${theme.slug}-stripe-webhook-secret`,
        publishableKey: `${theme.slug}-stripe-publishable-key`,
      },
    },
    {
      id: `${tenantId}-provider-naps`,
      provider: Provider.NAPS,
      credentials: {
        merchantId: `${theme.prefix}_MERCHANT`,
        terminalId: `${theme.prefix}_TERMINAL`,
        secretKey: `${theme.slug}-naps-secret`,
        baseUrl: "https://sandbox.naps.example",
      },
    },
  ];
  for (const spec of providerSpecs) {
    await prisma.providerConfig.upsert({
      where: { tenantId_provider: { tenantId, provider: spec.provider } },
      create: {
        id: spec.id,
        tenantId,
        provider: spec.provider,
        encryptedCredentials: encryptCredentials(spec.credentials),
        status: ProviderConfigStatus.CONNECTED,
        environment: Environment.SANDBOX,
      },
      update: { status: ProviderConfigStatus.CONNECTED },
    });
  }

  // ── Payment links ─────────────────────────────────────────────────────────
  const links: Prisma.PaymentLinkUncheckedCreateInput[] = [
    {
      id: `${tenantId}-link-one-time`,
      tenantId,
      slug: `${tenantId}-link-one-time`,
      amount: theme.oneTime,
      currency: "MAD",
      description: "One-time payment",
      reference: `${theme.prefix}-ONETIME`,
      customerName: "Sandbox Customer",
      customerEmail: `customer@${theme.domain}`,
      provider: Provider.VPS,
      status: PaymentLinkStatus.ACTIVE,
      maxAttempts: 3,
      attemptCount: 1,
      expiresAt: null,
      isRecurring: false,
      isInstallment: false,
      createdAt: d(1),
    },
    {
      id: `${tenantId}-link-recurring`,
      tenantId,
      slug: `${tenantId}-link-recurring`,
      amount: theme.recurring,
      currency: "MAD",
      description: "Monthly subscription",
      reference: `${theme.prefix}-RECURRING`,
      provider: Provider.VPS,
      status: PaymentLinkStatus.ACTIVE,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: null,
      isRecurring: true,
      billingInterval: BillingInterval.MONTHLY,
      intervalValue: 1,
      maxRetries: 3,
      isInstallment: false,
      createdAt: d(2),
    },
    {
      id: `${tenantId}-link-installment`,
      tenantId,
      slug: `${tenantId}-link-installment`,
      amount: theme.installmentPrincipal,
      currency: "MAD",
      description: "3-month installment plan",
      reference: `${theme.prefix}-INSTALLMENT`,
      provider: Provider.VPS,
      status: PaymentLinkStatus.ACTIVE,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: null,
      isRecurring: false,
      isInstallment: true,
      createdAt: d(3),
    },
    {
      id: `${tenantId}-link-expired`,
      tenantId,
      slug: `${tenantId}-link-expired`,
      amount: 40,
      currency: "MAD",
      description: "Expired one-time payment",
      reference: `${theme.prefix}-EXPIRED`,
      provider: Provider.VPS,
      status: PaymentLinkStatus.EXPIRED,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: d(5),
      isRecurring: false,
      isInstallment: false,
      createdAt: d(1),
    },
    {
      id: `${tenantId}-link-cancelled`,
      tenantId,
      slug: `${tenantId}-link-cancelled`,
      amount: 75,
      currency: "MAD",
      description: "Cancelled one-time payment",
      reference: `${theme.prefix}-CANCELLED`,
      provider: Provider.VPS,
      status: PaymentLinkStatus.CANCELED,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: null,
      isRecurring: false,
      isInstallment: false,
      createdAt: d(4),
    },
    {
      id: `${tenantId}-link-paid`,
      tenantId,
      slug: `${tenantId}-link-paid`,
      amount: 120,
      currency: "MAD",
      description: "Already-paid link",
      reference: `${theme.prefix}-PAID`,
      provider: Provider.STRIPE,
      status: PaymentLinkStatus.PAID,
      maxAttempts: 1,
      attemptCount: 1,
      expiresAt: null,
      isRecurring: false,
      isInstallment: false,
      createdAt: d(2),
    },
  ];
  for (const link of links) {
    await prisma.paymentLink.upsert({
      where: { slug: link.slug as string },
      create: link,
      update: { status: link.status },
    });
  }

  // ── Payment intents ───────────────────────────────────────────────────────
  const intents: Prisma.PaymentIntentUncheckedCreateInput[] = [
    {
      id: `${tenantId}-intent-succeeded`,
      tenantId,
      paymentLinkId: `${tenantId}-link-one-time`,
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-succeeded`,
      correlationId: `${tenantId}-corr-succeeded`,
      providerData: { redirectUrl: "https://fake.example/checkout" },
      customerIp: "203.0.113.10",
      metadata: {
        amount: cents(theme.oneTime),
        currency: "MAD",
        reference: `${theme.prefix}-ONETIME`,
      },
      createdAt: d(10, 8),
    },
    {
      id: `${tenantId}-intent-processing`,
      tenantId,
      paymentLinkId: null,
      status: PaymentIntentStatus.PROCESSING,
      provider: Provider.STRIPE,
      providerRef: `pi_${tenantId}_processing`,
      correlationId: `${tenantId}-corr-processing`,
      providerData: { redirectUrl: "https://checkout.stripe.com/pay/sandbox" },
      customerIp: "203.0.113.11",
      metadata: { amount: 5000, currency: "MAD", reference: `${theme.prefix}-PROCESSING` },
      createdAt: d(12, 1),
    },
    {
      id: `${tenantId}-intent-failed`,
      tenantId,
      paymentLinkId: null,
      status: PaymentIntentStatus.FAILED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-failed`,
      correlationId: `${tenantId}-corr-failed`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.12",
      metadata: {
        amount: 9000,
        currency: "MAD",
        reference: `${theme.prefix}-FAILED`,
        description: "Declined",
      },
      createdAt: d(11, 2),
    },
    {
      id: `${tenantId}-intent-refunded`,
      tenantId,
      paymentLinkId: `${tenantId}-link-one-time`,
      status: PaymentIntentStatus.REFUNDED,
      provider: Provider.STRIPE,
      providerRef: `pi_${tenantId}_refunded`,
      correlationId: `${tenantId}-corr-refunded`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.14",
      metadata: {
        amount: cents(theme.oneTime),
        currency: "MAD",
        reference: `${theme.prefix}-ONETIME`,
      },
      createdAt: d(10, 9),
    },
    {
      id: `${tenantId}-intent-refunded-full`,
      tenantId,
      paymentLinkId: null,
      status: PaymentIntentStatus.REFUNDED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-refunded-full`,
      correlationId: `${tenantId}-corr-refunded-full`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.15",
      metadata: {
        amount: cents(theme.recurring),
        currency: "MAD",
        reference: `${theme.prefix}-FULLREFUND`,
      },
      createdAt: d(9, 6),
    },
    {
      id: `${tenantId}-intent-sub-active`,
      tenantId,
      paymentLinkId: `${tenantId}-link-recurring`,
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-sub-active`,
      correlationId: `${tenantId}-corr-sub-active`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.20",
      metadata: {
        amount: cents(theme.recurring),
        currency: "MAD",
        reference: `${theme.prefix}-RECURRING`,
      },
      createdAt: d(20, 0),
    },
    {
      id: `${tenantId}-intent-sub-pastdue`,
      tenantId,
      paymentLinkId: `${tenantId}-link-recurring`,
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-sub-pastdue`,
      correlationId: `${tenantId}-corr-sub-pastdue`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.21",
      metadata: {
        amount: cents(theme.recurring),
        currency: "MAD",
        reference: `${theme.prefix}-RECURRING`,
      },
      createdAt: d(15, 0),
    },
    {
      id: `${tenantId}-intent-sub-cancelled`,
      tenantId,
      paymentLinkId: `${tenantId}-link-recurring`,
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-sub-cancelled`,
      correlationId: `${tenantId}-corr-sub-cancelled`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.22",
      metadata: {
        amount: cents(theme.recurring),
        currency: "MAD",
        reference: `${theme.prefix}-RECURRING`,
      },
      createdAt: d(12, 0),
    },
    {
      id: `${tenantId}-intent-installment`,
      tenantId,
      paymentLinkId: `${tenantId}-link-installment`,
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: `${tenantId}-vps-installment`,
      correlationId: `${tenantId}-corr-installment`,
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.23",
      metadata: { bnpl: true, installmentAgreementId: `${tenantId}-agreement` },
      createdAt: d(18, 0),
    },
  ];
  for (const intent of intents) {
    await prisma.paymentIntent.upsert({
      where: { correlationId: intent.correlationId as string },
      create: intent,
      update: { status: intent.status },
    });
  }

  // ── Provider transactions ─────────────────────────────────────────────────
  const ptxs: Prisma.ProviderTransactionUncheckedCreateInput[] = [
    {
      id: `${tenantId}-ptx-succeeded`,
      paymentIntentId: `${tenantId}-intent-succeeded`,
      provider: Provider.VPS,
      providerTransactionId: `${tenantId}-vps-succeeded`,
      rawRequest: { command: "CHARGE", amount: theme.oneTime },
      rawResponse: { status: "CHARGED", id: `${tenantId}-vps-succeeded` },
      createdAt: d(10, 8),
    },
    {
      id: `${tenantId}-ptx-refunded`,
      paymentIntentId: `${tenantId}-intent-refunded`,
      provider: Provider.STRIPE,
      providerTransactionId: `pi_${tenantId}_refunded`,
      rawRequest: { payment_intent: `pi_${tenantId}_refunded`, amount: cents(theme.oneTime) },
      rawResponse: { status: "succeeded", id: `re_${tenantId}_partial` },
      createdAt: d(10, 10),
    },
    {
      id: `${tenantId}-ptx-failed`,
      paymentIntentId: `${tenantId}-intent-failed`,
      provider: Provider.VPS,
      providerTransactionId: null,
      rawRequest: { command: "CHARGE", amount: 90 },
      rawResponse: { status: "DECLINED", message: "Insufficient funds" },
      createdAt: d(11, 2),
    },
    {
      id: `${tenantId}-ptx-webhook`,
      paymentIntentId: `${tenantId}-intent-succeeded`,
      provider: Provider.VPS,
      providerTransactionId: `${tenantId}-vps-succeeded`,
      rawRequest: Prisma.DbNull,
      rawResponse: { status: "CHARGED", id: `${tenantId}-vps-succeeded` },
      createdAt: d(10, 8),
    },
  ];
  for (const ptx of ptxs) {
    await prisma.providerTransaction.upsert({
      where: { id: ptx.id as string },
      create: ptx,
      update: {},
    });
  }

  // ── Refunds (partial + full) ──────────────────────────────────────────────
  const ownerUserId = `${tenantId}-user-owner`;
  const refunds: Prisma.RefundUncheckedCreateInput[] = [
    {
      id: `${tenantId}-refund-partial`,
      paymentIntentId: `${tenantId}-intent-refunded`,
      tenantId,
      initiatedBy: ownerUserId,
      status: RefundStatus.SUCCEEDED,
      providerRefundRef: `re_${tenantId}_partial`,
      amount: Math.round((theme.oneTime / 5) * 100) / 100, // ~20% partial
      currency: "MAD",
      createdAt: d(10, 10),
    },
    {
      id: `${tenantId}-refund-full`,
      paymentIntentId: `${tenantId}-intent-refunded-full`,
      tenantId,
      initiatedBy: ownerUserId,
      status: RefundStatus.SUCCEEDED,
      providerRefundRef: `${tenantId}-vps-refund-full`,
      amount: theme.recurring,
      currency: "MAD",
      createdAt: d(9, 7),
    },
  ];
  for (const refund of refunds) {
    await prisma.refund.upsert({ where: { id: refund.id as string }, create: refund, update: {} });
  }

  // ── Subscriptions + billing events ────────────────────────────────────────
  const subs = [
    {
      id: `${tenantId}-sub-active`,
      intent: `${tenantId}-intent-sub-active`,
      status: SubscriptionStatus.ACTIVE,
      day: 20,
    },
    {
      id: `${tenantId}-sub-pastdue`,
      intent: `${tenantId}-intent-sub-pastdue`,
      status: SubscriptionStatus.PAST_DUE,
      day: 15,
    },
    {
      id: `${tenantId}-sub-cancelled`,
      intent: `${tenantId}-intent-sub-cancelled`,
      status: SubscriptionStatus.CANCELLED,
      day: 12,
    },
  ];
  for (const sub of subs) {
    await prisma.subscription.upsert({
      where: { id: sub.id },
      create: {
        id: sub.id,
        tenantId,
        customerId: `cust-${sub.id}`,
        encryptedStoredProfileId: encrypt(`${tenantId}-stored-profile`),
        initialPaymentIntentId: sub.intent,
        paymentLinkId: `${tenantId}-link-recurring`,
        status: sub.status,
        amount: theme.recurring,
        currency: "MAD",
        intervalType: BillingInterval.MONTHLY,
        intervalValue: 1,
        nextBillingDate: d(sub.day + 30),
        currentPeriodStart: d(sub.day),
        currentPeriodEnd: d(sub.day + 30),
        retryCount: sub.status === SubscriptionStatus.PAST_DUE ? 2 : 0,
        maxRetries: 3,
      },
      update: { status: sub.status },
    });
  }

  const billingEvents: Prisma.BillingEventUncheckedCreateInput[] = [
    {
      id: `${tenantId}-be-active-1`,
      subscriptionId: `${tenantId}-sub-active`,
      chargeId: `${tenantId}-charge-active-1`,
      vpsTransactionId: `${tenantId}-vps-sub-active`,
      amount: theme.recurring,
      currency: "MAD",
      status: "CHARGED",
      attemptNumber: 1,
      billingPeriodStart: d(20),
      billingPeriodEnd: d(50),
      processedAt: d(20, 1),
      createdAt: d(20),
    },
    {
      id: `${tenantId}-be-pastdue-1`,
      subscriptionId: `${tenantId}-sub-pastdue`,
      chargeId: `${tenantId}-charge-pastdue-1`,
      vpsTransactionId: `${tenantId}-vps-sub-pastdue`,
      amount: theme.recurring,
      currency: "MAD",
      status: "CHARGED",
      attemptNumber: 1,
      billingPeriodStart: d(15),
      billingPeriodEnd: d(45),
      processedAt: d(15, 1),
      createdAt: d(15),
    },
    {
      id: `${tenantId}-be-pastdue-2`,
      subscriptionId: `${tenantId}-sub-pastdue`,
      chargeId: `${tenantId}-charge-pastdue-2`,
      vpsTransactionId: null,
      amount: theme.recurring,
      currency: "MAD",
      status: "DECLINED",
      attemptNumber: 2,
      errorMessage: "Insufficient funds",
      createdAt: d(15, 1),
    },
    {
      id: `${tenantId}-be-cancelled-1`,
      subscriptionId: `${tenantId}-sub-cancelled`,
      chargeId: `${tenantId}-charge-cancelled-1`,
      vpsTransactionId: `${tenantId}-vps-sub-cancelled`,
      amount: theme.recurring,
      currency: "MAD",
      status: "CHARGED",
      attemptNumber: 1,
      billingPeriodStart: d(12),
      billingPeriodEnd: d(42),
      processedAt: d(12, 1),
      createdAt: d(12),
    },
  ];
  for (const event of billingEvents) {
    await prisma.billingEvent.upsert({
      where: { id: event.id as string },
      create: event,
      update: {},
    });
  }

  // ── Installment plans ─────────────────────────────────────────────────────
  const planIds: Record<number, string> = {};
  for (const [months, apr] of APRS) {
    const id = `${tenantId}-plan-${months}`;
    planIds[months] = id;
    await prisma.installmentPlan.upsert({
      where: { id },
      create: {
        id,
        tenantId,
        name: `Pay in ${months}`,
        durationMonths: months,
        annualInterestRate: apr,
        minAmount: 100,
        maxAmount: 100_000,
        isActive: true,
      },
      update: { annualInterestRate: apr, isActive: true },
    });
  }

  // ── Installment agreement + charges ───────────────────────────────────────
  const down = Math.round((theme.installmentPrincipal / 3) * 100) / 100;
  const remaining = Math.round((theme.installmentPrincipal - down) * 100) / 100;
  const perCharge = Math.round((remaining / 2) * 100) / 100;
  const agreementId = `${tenantId}-agreement`;
  await prisma.installmentAgreement.upsert({
    where: { id: agreementId },
    create: {
      id: agreementId,
      tenantId,
      customerId: `cust-${tenantId}-bnpl`,
      planId: planIds[3],
      paymentLinkId: `${tenantId}-link-installment`,
      initialPaymentIntentId: `${tenantId}-intent-installment`,
      encryptedStoredProfileId: encrypt(`${tenantId}-stored-profile`),
      status: InstallmentAgreementStatus.ACTIVE,
      principalAmount: theme.installmentPrincipal,
      downPayment: down,
      installmentAmount: perCharge,
      totalInstallments: 3,
      paidCount: 1,
      currency: "MAD",
      nextChargeDate: d(48),
    },
    update: { status: InstallmentAgreementStatus.ACTIVE },
  });

  const charges: Prisma.InstallmentChargeUncheckedCreateInput[] = [
    {
      id: `${tenantId}-charge-1`,
      agreementId,
      installmentNumber: 1,
      dueDate: d(18),
      amount: down,
      currency: "MAD",
      status: "CHARGED",
      chargeId: `${tenantId}-charge-1-tx`,
      vpsTransactionId: `${tenantId}-vps-installment`,
      attemptNumber: 1,
      processedAt: d(18, 1),
      createdAt: d(18),
    },
    {
      id: `${tenantId}-charge-2`,
      agreementId,
      installmentNumber: 2,
      dueDate: d(48),
      amount: perCharge,
      currency: "MAD",
      status: "PENDING",
      chargeId: `${tenantId}-charge-2-tx`,
      attemptNumber: 1,
      createdAt: d(18),
    },
    {
      id: `${tenantId}-charge-3`,
      agreementId,
      installmentNumber: 3,
      dueDate: d(78),
      amount: perCharge,
      currency: "MAD",
      status: "PENDING",
      chargeId: `${tenantId}-charge-3-tx`,
      attemptNumber: 1,
      createdAt: d(18),
    },
  ];
  for (const charge of charges) {
    await prisma.installmentCharge.upsert({
      where: { id: charge.id as string },
      create: charge,
      update: {},
    });
  }

  // ── API keys (active + revoked) ───────────────────────────────────────────
  const apiKeySpecs = [
    {
      id: `${tenantId}-apikey-active`,
      name: "Sandbox active key",
      rawKey: `cp_sand_${theme.slug}_active_0001`,
      revokedAt: null,
    },
    {
      id: `${tenantId}-apikey-revoked`,
      name: "Sandbox revoked key",
      rawKey: `cp_sand_${theme.slug}_revoked_0001`,
      revokedAt: d(60),
    },
  ];
  for (const spec of apiKeySpecs) {
    const keySha256 = crypto.createHash("sha256").update(spec.rawKey).digest("hex");
    await prisma.apiKey.upsert({
      where: { id: spec.id },
      create: {
        id: spec.id,
        tenantId,
        name: spec.name,
        keyHash: await bcrypt.hash(spec.rawKey, 10),
        keySha256,
        keyPrefix: spec.rawKey.slice(0, 16),
        revokedAt: spec.revokedAt,
      },
      update: {},
    });
  }

  // ── Webhook events (verified / unverified / duplicate) ────────────────────
  const webhooks: Prisma.WebhookEventUncheckedCreateInput[] = [
    {
      id: `${tenantId}-wh-verified`,
      provider: Provider.VPS,
      tenantId,
      paymentIntentId: `${tenantId}-intent-succeeded`,
      rawPayload: { event: "charge.changed", status: "CHARGED", id: `${tenantId}-vps-succeeded` },
      headers: { "x-signature": "valid-demo" },
      signatureVerified: true,
      processed: true,
      mappedStatus: "SUCCEEDED",
      idempotencyKey: `${tenantId}-wh-verified-key`,
      createdAt: d(10, 8),
    },
    {
      id: `${tenantId}-wh-unverified`,
      provider: Provider.VPS,
      tenantId,
      paymentIntentId: `${tenantId}-intent-succeeded`,
      rawPayload: { event: "charge.changed", status: "CHARGED" },
      headers: {},
      signatureVerified: false,
      processed: false,
      idempotencyKey: `${tenantId}-wh-unverified-key`,
      createdAt: d(10, 9),
    },
    {
      id: `${tenantId}-wh-duplicate`,
      provider: Provider.VPS,
      tenantId,
      paymentIntentId: `${tenantId}-intent-succeeded`,
      rawPayload: { event: "charge.changed", status: "CHARGED", id: `${tenantId}-vps-succeeded` },
      headers: { "x-signature": "valid-demo" },
      signatureVerified: true,
      processed: true,
      mappedStatus: "SUCCEEDED",
      idempotencyKey: `${tenantId}-wh-duplicate-key`, // distinct key: @unique forbids two rows sharing one
      createdAt: d(10, 10),
    },
  ];
  for (const event of webhooks) {
    await prisma.webhookEvent.upsert({
      where: { id: event.id as string },
      create: event,
      update: {},
    });
  }
}

/**
 * Seed the full sandbox: the demo tenant (reused) + every theme tenant.
 */
export async function seedSandboxData(prisma: PrismaClientType): Promise<void> {
  await seedDemoData(prisma);
  for (const theme of THEMES) {
    await seedTenant(prisma, theme);
    console.log(`✅ Seeded tenant "${theme.slug}" (${theme.name}).`);
  }
}

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) {
    console.error("❌ ENCRYPTION_KEY is required (64 hex chars) to seed sandbox credentials.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is required.");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    await seedSandboxData(prisma);
    console.log("✅ Sandbox seed complete (demo + otoparking + jabadoor).");
  } catch (err) {
    console.error("❌ Sandbox seed failed:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  void main();
}
