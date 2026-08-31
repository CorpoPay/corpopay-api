/**
 * seed-demo-data.ts — the single source of demo data.
 *
 * Deterministic, idempotent-by-design fixture factory for the "Demo Merchant"
 * tenant. This file contains NO randomness, NO `Date.now()`, and NO crypto:
 * every ID, slug, correlationId and timestamp is a fixed literal so the dataset
 * is byte-for-byte reproducible for demos, snapshots and E2E tests.
 *
 * Split from `seed-demo.ts` so the data stays pure:
 *   - Values that need bcrypt (user passwords), SHA-256 (API key hashes) or
 *     AES-GCM (provider credentials / stored payment profiles) are exported as
 *     *specs* here and materialised by the seeder, which owns the crypto keys.
 *   - Everything else is a complete Prisma `UncheckedCreateInput` so the seeder
 *     is a mechanical upsert loop.
 *
 * Money invariant: DB columns are MAD `Decimal(12,2)`. Amounts below are written
 * as MAD numbers directly (they live at the DB layer; conversion helpers are for
 * the API / provider boundary, not for seed rows).
 */

import {
  BillingInterval,
  Environment,
  InstallmentAgreementStatus,
  PaymentIntentStatus,
  PaymentLinkStatus,
  Prisma,
  Provider,
  ProviderConfigStatus,
  RefundStatus,
  SubscriptionStatus,
  UserRole,
} from "../src/generated/prisma/client";

// ─── Deterministic timeline ────────────────────────────────────────────────────
// All timestamps are fixed offsets from a single base instant. The base is far
// enough in the past that "expired" / "past-due" / "cancelled" states stay
// genuinely in the past relative to any realistic demo runtime.
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00.000Z

/** Fixed date `dayOffset` days (and `hourOffset` hours) after the base. */
function demoDate(dayOffset: number, hourOffset = 0): Date {
  return new Date(BASE_MS + dayOffset * 86_400_000 + hourOffset * 3_600_000);
}

export const DEMO_TENANT_ID = "demo-tenant";
const DEMO_TENANT_SLUG = "demo";

// ─── Tenant ─────────────────────────────────────────────────────────────────────

export function demoTenant(): Prisma.TenantUncheckedCreateInput {
  return {
    id: DEMO_TENANT_ID,
    name: "Demo Merchant",
    slug: DEMO_TENANT_SLUG,
    status: "ACTIVE",
    environment: Environment.SANDBOX,
    notifyEmail: "billing@demo.ma",
    notifyWebhookUrl: null,
    createdAt: demoDate(0),
  };
}

// ─── Users ──────────────────────────────────────────────────────────────────────
// Passwords are hashed by the seeder (bcrypt uses a random salt, so the hash
// cannot be a fixed literal).

export interface DemoUserSpec {
  id: string;
  email: string;
  role: UserRole;
  /** Plain-text demo password — hashed at seed time. */
  password: string;
}

export function demoUsers(): DemoUserSpec[] {
  return [
    {
      id: "demo-user-admin",
      email: "admin@demo.ma",
      role: UserRole.SUPER_ADMIN,
      password: "DemoAdmin123!",
    },
    {
      id: "demo-user-owner",
      email: "owner@demo.ma",
      role: UserRole.OWNER,
      password: "DemoOwner123!",
    },
    // No true read-only role exists in the UserRole enum; STAFF is the least
    // privileged merchant role and exercises the OWNER-only-vs-STAFF RBAC split.
    {
      id: "demo-user-viewer",
      email: "viewer@demo.ma",
      role: UserRole.STAFF,
      password: "DemoViewer123!",
    },
  ];
}

// ─── Provider configs ───────────────────────────────────────────────────────────
// Credentials are encrypted by the seeder. These are clearly-fake test values
// (never real PSP secrets). The VPS config doubles as the deterministic "fake"
// backbone: with DEMO_MODE=true the adapter registry returns the in-memory
// FakeAdapter for any provider, so the VPS rows below drive E2E with no network.

export interface DemoProviderConfigSpec {
  id: string;
  provider: Provider;
  status: ProviderConfigStatus;
  environment: Environment;
  credentials: Record<string, unknown>;
}

export function demoProviderConfigs(): DemoProviderConfigSpec[] {
  return [
    {
      id: "demo-provider-vps",
      provider: Provider.VPS,
      status: ProviderConfigStatus.CONNECTED,
      environment: Environment.SANDBOX,
      credentials: {
        merchantAccount: "Int_demo_Test",
        paywallSecretKey: "demo-paywall-secret",
        paywallUrl: "https://payment-sandbox.payzone.ma/pwthree/launch",
        skin: "vps-1-vue",
        mode: "DEEP_LINK",
        showPaymentProfiles: "false",
        apiUrl: "https://payment-sandbox.payzone.ma",
        callerName: "$apicaller",
        callerPassword: "demo-caller-password",
        notificationKey: "demo-notification-key",
        callbackTestMode: true, // demo only — never set in production
      },
    },
    {
      id: "demo-provider-stripe",
      provider: Provider.STRIPE,
      status: ProviderConfigStatus.CONNECTED,
      environment: Environment.SANDBOX,
      credentials: {
        // Demo placeholders only — swap in your own Stripe sandbox test keys.
        secretKey: "demo-stripe-secret-key",
        webhookSecret: "demo-stripe-webhook-secret",
        publishableKey: "demo-stripe-publishable-key",
      },
    },
    {
      id: "demo-provider-naps",
      provider: Provider.NAPS,
      status: ProviderConfigStatus.CONNECTED,
      environment: Environment.SANDBOX,
      credentials: {
        merchantId: "DEMO_MERCHANT",
        terminalId: "DEMO_TERMINAL",
        secretKey: "demo-naps-secret",
        baseUrl: "https://sandbox.naps.example",
      },
    },
  ];
}

// ─── Payment links ──────────────────────────────────────────────────────────────

export function demoPaymentLinks(): Prisma.PaymentLinkUncheckedCreateInput[] {
  return [
    {
      id: "demo-link-one-time",
      tenantId: DEMO_TENANT_ID,
      slug: "demo-link-one-time",
      amount: 250.0,
      currency: "MAD",
      description: "One-time payment",
      reference: "REF-ONETIME",
      customerName: "Demo Customer",
      customerEmail: "customer@demo.ma",
      provider: Provider.VPS,
      status: PaymentLinkStatus.ACTIVE,
      maxAttempts: 3,
      attemptCount: 1,
      expiresAt: null,
      isRecurring: false,
      isInstallment: false,
      createdAt: demoDate(1),
    },
    {
      id: "demo-link-recurring",
      tenantId: DEMO_TENANT_ID,
      slug: "demo-link-recurring",
      amount: 99.0,
      currency: "MAD",
      description: "Monthly subscription",
      reference: "REF-RECURRING",
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
      createdAt: demoDate(2),
    },
    {
      id: "demo-link-installment",
      tenantId: DEMO_TENANT_ID,
      slug: "demo-link-installment",
      amount: 1500.0,
      currency: "MAD",
      description: "3-month installment plan",
      reference: "REF-INSTALLMENT",
      provider: Provider.VPS,
      status: PaymentLinkStatus.ACTIVE,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: null,
      isRecurring: false,
      isInstallment: true,
      createdAt: demoDate(3),
    },
    {
      id: "demo-link-expired",
      tenantId: DEMO_TENANT_ID,
      slug: "demo-link-expired",
      amount: 40.0,
      currency: "MAD",
      description: "Expired one-time payment",
      reference: "REF-EXPIRED",
      provider: Provider.VPS,
      status: PaymentLinkStatus.EXPIRED,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: demoDate(5),
      isRecurring: false,
      isInstallment: false,
      createdAt: demoDate(1),
    },
    {
      id: "demo-link-cancelled",
      tenantId: DEMO_TENANT_ID,
      slug: "demo-link-cancelled",
      amount: 75.0,
      currency: "MAD",
      description: "Cancelled one-time payment",
      reference: "REF-CANCELLED",
      provider: Provider.VPS,
      status: PaymentLinkStatus.CANCELED,
      maxAttempts: 1,
      attemptCount: 0,
      expiresAt: null,
      isRecurring: false,
      isInstallment: false,
      createdAt: demoDate(4),
    },
    {
      id: "demo-link-paid",
      tenantId: DEMO_TENANT_ID,
      slug: "demo-link-paid",
      amount: 120.0,
      currency: "MAD",
      description: "Already-paid link",
      reference: "REF-PAID",
      provider: Provider.STRIPE,
      status: PaymentLinkStatus.PAID,
      maxAttempts: 1,
      attemptCount: 1,
      expiresAt: null,
      isRecurring: false,
      isInstallment: false,
      createdAt: demoDate(2),
    },
  ];
}

// ─── Payment intents ────────────────────────────────────────────────────────────

export function demoPaymentIntents(): Prisma.PaymentIntentUncheckedCreateInput[] {
  return [
    {
      id: "demo-intent-succeeded",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-one-time",
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: "vps-tx-succeeded",
      correlationId: "demo-corr-succeeded",
      providerData: { redirectUrl: "https://fake.example/checkout" },
      customerIp: "203.0.113.10",
      metadata: { amount: 25000, currency: "MAD", reference: "REF-ONETIME" },
      createdAt: demoDate(10, 8),
    },
    {
      id: "demo-intent-pending",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: null,
      status: PaymentIntentStatus.PROCESSING,
      provider: Provider.STRIPE,
      providerRef: "pi_demo_pending",
      correlationId: "demo-corr-pending",
      providerData: { redirectUrl: "https://checkout.stripe.com/pay/demo" },
      customerIp: "203.0.113.11",
      metadata: {
        amount: 5000,
        currency: "MAD",
        reference: "REF-PENDING",
        description: "Direct pending",
      },
      createdAt: demoDate(12, 1),
    },
    {
      id: "demo-intent-failed",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: null,
      status: PaymentIntentStatus.FAILED,
      provider: Provider.VPS,
      providerRef: "vps-tx-failed",
      correlationId: "demo-corr-failed",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.12",
      metadata: { amount: 9000, currency: "MAD", reference: "REF-FAILED", description: "Declined" },
      createdAt: demoDate(11, 2),
    },
    {
      id: "demo-intent-expired",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-expired",
      status: PaymentIntentStatus.FAILED, // no dedicated EXPIRED intent status — timed-out intents are FAILED
      provider: Provider.VPS,
      providerRef: "vps-tx-expired",
      correlationId: "demo-corr-expired",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.13",
      metadata: { amount: 4000, currency: "MAD", reference: "REF-EXPIRED" },
      createdAt: demoDate(6, 3),
    },
    {
      id: "demo-intent-refunded",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-one-time",
      status: PaymentIntentStatus.REFUNDED,
      provider: Provider.STRIPE,
      providerRef: "pi_demo_refunded",
      correlationId: "demo-corr-refunded",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.14",
      metadata: { amount: 25000, currency: "MAD", reference: "REF-ONETIME" },
      createdAt: demoDate(10, 9),
    },
    {
      id: "demo-intent-refunded-full",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: null,
      status: PaymentIntentStatus.REFUNDED,
      provider: Provider.VPS,
      providerRef: "vps-tx-refunded-full",
      correlationId: "demo-corr-refunded-full",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.15",
      metadata: {
        amount: 19900,
        currency: "MAD",
        reference: "REF-FULL-REFUND",
        description: "Full refund",
      },
      createdAt: demoDate(9, 6),
    },
    // ── Backing intents for subscriptions / installment agreement ─────────────
    {
      id: "demo-intent-sub-active",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-recurring",
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: "vps-tx-sub-active",
      correlationId: "demo-corr-sub-active",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.20",
      metadata: { amount: 9900, currency: "MAD", reference: "REF-RECURRING" },
      createdAt: demoDate(20, 0),
    },
    {
      id: "demo-intent-sub-pastdue",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-recurring",
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: "vps-tx-sub-pastdue",
      correlationId: "demo-corr-sub-pastdue",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.21",
      metadata: { amount: 9900, currency: "MAD", reference: "REF-RECURRING" },
      createdAt: demoDate(15, 0),
    },
    {
      id: "demo-intent-sub-cancelled",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-recurring",
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: "vps-tx-sub-cancelled",
      correlationId: "demo-corr-sub-cancelled",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.22",
      metadata: { amount: 9900, currency: "MAD", reference: "REF-RECURRING" },
      createdAt: demoDate(12, 0),
    },
    {
      id: "demo-intent-installment",
      tenantId: DEMO_TENANT_ID,
      paymentLinkId: "demo-link-installment",
      status: PaymentIntentStatus.SUCCEEDED,
      provider: Provider.VPS,
      providerRef: "vps-tx-installment",
      correlationId: "demo-corr-installment",
      providerData: Prisma.DbNull,
      customerIp: "203.0.113.23",
      metadata: { bnpl: true, installmentAgreementId: "demo-agreement" },
      createdAt: demoDate(18, 0),
    },
  ];
}

// ─── Provider transactions ──────────────────────────────────────────────────────

export function demoProviderTransactions(): Prisma.ProviderTransactionUncheckedCreateInput[] {
  return [
    {
      id: "demo-ptx-succeeded",
      paymentIntentId: "demo-intent-succeeded",
      provider: Provider.VPS,
      providerTransactionId: "vps-tx-succeeded",
      rawRequest: { command: "CHARGE", amount: 250.0 },
      rawResponse: { status: "CHARGED", id: "vps-tx-succeeded" },
      createdAt: demoDate(10, 8),
    },
    {
      id: "demo-ptx-refunded",
      paymentIntentId: "demo-intent-refunded",
      provider: Provider.STRIPE,
      providerTransactionId: "pi_demo_refunded",
      rawRequest: { payment_intent: "pi_demo_refunded", amount: 5000 },
      rawResponse: { status: "succeeded", id: "re_demo_partial" },
      createdAt: demoDate(10, 10),
    },
    {
      id: "demo-ptx-failed",
      paymentIntentId: "demo-intent-failed",
      provider: Provider.VPS,
      providerTransactionId: null,
      rawRequest: { command: "CHARGE", amount: 90.0 },
      rawResponse: { status: "DECLINED", message: "Insufficient funds" },
      createdAt: demoDate(11, 2),
    },
    {
      id: "demo-ptx-webhook",
      paymentIntentId: "demo-intent-succeeded",
      provider: Provider.VPS,
      providerTransactionId: "vps-tx-succeeded",
      rawRequest: Prisma.DbNull,
      rawResponse: { status: "CHARGED", id: "vps-tx-succeeded" },
      createdAt: demoDate(10, 8),
    },
  ];
}

// ─── Refunds ────────────────────────────────────────────────────────────────────

export function demoRefunds(): Prisma.RefundUncheckedCreateInput[] {
  return [
    {
      id: "demo-refund-partial",
      paymentIntentId: "demo-intent-refunded",
      tenantId: DEMO_TENANT_ID,
      initiatedBy: "demo-user-owner",
      status: RefundStatus.SUCCEEDED,
      providerRefundRef: "re_demo_partial",
      amount: 50.0, // partial refund of the 250.00 payment
      currency: "MAD",
      createdAt: demoDate(10, 11),
    },
    {
      id: "demo-refund-full",
      paymentIntentId: "demo-intent-refunded-full",
      tenantId: DEMO_TENANT_ID,
      initiatedBy: "demo-user-owner",
      status: RefundStatus.SUCCEEDED,
      providerRefundRef: "vps-refund-full",
      amount: 199.0, // full refund
      currency: "MAD",
      createdAt: demoDate(9, 7),
    },
  ];
}

// ─── Subscriptions ──────────────────────────────────────────────────────────────
// `storedProfileId` is encrypted into `encryptedStoredProfileId` by the seeder.

export interface DemoSubscriptionSpec {
  id: string;
  customerId: string;
  initialPaymentIntentId: string;
  paymentLinkId: string;
  status: SubscriptionStatus;
  amount: number; // MAD
  currency: string;
  intervalType: BillingInterval;
  intervalValue: number;
  nextBillingDate: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  retryCount: number;
  storedProfileId: string;
}

export function demoSubscriptions(): DemoSubscriptionSpec[] {
  return [
    {
      id: "demo-sub-active",
      customerId: "cust-active",
      initialPaymentIntentId: "demo-intent-sub-active",
      paymentLinkId: "demo-link-recurring",
      status: SubscriptionStatus.ACTIVE,
      amount: 99.0,
      currency: "MAD",
      intervalType: BillingInterval.MONTHLY,
      intervalValue: 1,
      nextBillingDate: demoDate(45),
      currentPeriodStart: demoDate(15),
      currentPeriodEnd: demoDate(45),
      retryCount: 0,
      storedProfileId: "profile-active",
    },
    {
      id: "demo-sub-past-due",
      customerId: "cust-pastdue",
      initialPaymentIntentId: "demo-intent-sub-pastdue",
      paymentLinkId: "demo-link-recurring",
      status: SubscriptionStatus.PAST_DUE,
      amount: 99.0,
      currency: "MAD",
      intervalType: BillingInterval.MONTHLY,
      intervalValue: 1,
      nextBillingDate: demoDate(16),
      currentPeriodStart: demoDate(1),
      currentPeriodEnd: demoDate(16),
      retryCount: 1,
      storedProfileId: "profile-pastdue",
    },
    {
      id: "demo-sub-cancelled",
      customerId: "cust-cancelled",
      initialPaymentIntentId: "demo-intent-sub-cancelled",
      paymentLinkId: "demo-link-recurring",
      status: SubscriptionStatus.CANCELLED,
      amount: 99.0,
      currency: "MAD",
      intervalType: BillingInterval.MONTHLY,
      intervalValue: 1,
      nextBillingDate: null,
      currentPeriodStart: demoDate(1),
      currentPeriodEnd: demoDate(12),
      retryCount: 0,
      storedProfileId: "profile-cancelled",
    },
  ];
}

// ─── Billing events ─────────────────────────────────────────────────────────────

export function demoBillingEvents(): Prisma.BillingEventUncheckedCreateInput[] {
  return [
    {
      id: "demo-bev-active-paid",
      subscriptionId: "demo-sub-active",
      chargeId: "renewal-demo-sub-active-2026-02-01",
      vpsTransactionId: "vps-billing-active",
      amount: 99.0,
      currency: "MAD",
      status: "CHARGED",
      attemptNumber: 1,
      billingPeriodStart: demoDate(15),
      billingPeriodEnd: demoDate(45),
      processedAt: demoDate(15, 1),
      errorMessage: null,
      createdAt: demoDate(15, 1),
    },
    {
      id: "demo-bev-pastdue-paid",
      subscriptionId: "demo-sub-past-due",
      chargeId: "renewal-demo-sub-past-due-2026-01-16",
      vpsTransactionId: "vps-billing-pastdue-1",
      amount: 99.0,
      currency: "MAD",
      status: "CHARGED",
      attemptNumber: 1,
      billingPeriodStart: demoDate(1),
      billingPeriodEnd: demoDate(16),
      processedAt: demoDate(16, 0),
      errorMessage: null,
      createdAt: demoDate(16, 0),
    },
    {
      id: "demo-bev-pastdue-failed",
      subscriptionId: "demo-sub-past-due",
      chargeId: "renewal-demo-sub-past-due-2026-02-01",
      vpsTransactionId: null,
      amount: 99.0,
      currency: "MAD",
      status: "DECLINED",
      attemptNumber: 1,
      billingPeriodStart: demoDate(16),
      billingPeriodEnd: demoDate(45),
      processedAt: demoDate(45, 0),
      errorMessage: "Insufficient funds",
      createdAt: demoDate(45, 0),
    },
    {
      id: "demo-bev-pastdue-retried",
      subscriptionId: "demo-sub-past-due",
      chargeId: "renewal-demo-sub-past-due-2026-02-01-r2",
      vpsTransactionId: null,
      amount: 99.0,
      currency: "MAD",
      status: "DECLINED",
      attemptNumber: 2,
      billingPeriodStart: demoDate(16),
      billingPeriodEnd: demoDate(45),
      processedAt: demoDate(46, 0),
      errorMessage: "Insufficient funds",
      createdAt: demoDate(46, 0),
    },
    {
      id: "demo-bev-cancelled-paid",
      subscriptionId: "demo-sub-cancelled",
      chargeId: "renewal-demo-sub-cancelled-2026-01-12",
      vpsTransactionId: "vps-billing-cancelled-1",
      amount: 99.0,
      currency: "MAD",
      status: "CHARGED",
      attemptNumber: 1,
      billingPeriodStart: demoDate(1),
      billingPeriodEnd: demoDate(12),
      processedAt: demoDate(12, 0),
      errorMessage: null,
      createdAt: demoDate(12, 0),
    },
  ];
}

// ─── Installment plan ───────────────────────────────────────────────────────────

export function demoInstallmentPlans(): Prisma.InstallmentPlanUncheckedCreateInput[] {
  return [
    {
      id: "demo-plan-3mo",
      tenantId: DEMO_TENANT_ID,
      name: "Pay in 3",
      durationMonths: 3,
      annualInterestRate: 8.99,
      minAmount: 100.0,
      maxAmount: 10000.0,
      isActive: true,
      createdAt: demoDate(1),
    },
  ];
}

// ─── Installment agreement + charges ────────────────────────────────────────────

export interface DemoInstallmentAgreementSpec {
  id: string;
  customerId: string;
  planId: string;
  paymentLinkId: string;
  initialPaymentIntentId: string;
  status: InstallmentAgreementStatus;
  principalAmount: number; // MAD
  downPayment: number; // MAD
  installmentAmount: number; // MAD
  totalInstallments: number;
  paidCount: number;
  currency: string;
  nextChargeDate: Date | null;
  storedProfileId: string;
}

export function demoInstallmentAgreement(): DemoInstallmentAgreementSpec {
  return {
    id: "demo-agreement",
    customerId: "demo-corr-installment",
    planId: "demo-plan-3mo",
    paymentLinkId: "demo-link-installment",
    initialPaymentIntentId: "demo-intent-installment",
    status: InstallmentAgreementStatus.ACTIVE,
    principalAmount: 1500.0,
    downPayment: 500.0,
    installmentAmount: 500.0,
    totalInstallments: 3,
    paidCount: 1,
    currency: "MAD",
    nextChargeDate: demoDate(48),
    storedProfileId: "profile-installment",
  };
}

export function demoInstallmentCharges(): Prisma.InstallmentChargeUncheckedCreateInput[] {
  return [
    {
      id: "demo-inst-charge-1",
      agreementId: "demo-agreement",
      installmentNumber: 1,
      dueDate: demoDate(18),
      amount: 500.0,
      currency: "MAD",
      status: "CHARGED",
      chargeId: "down-demo-agreement",
      vpsTransactionId: "vps-inst-1",
      attemptNumber: 1,
      processedAt: demoDate(18, 1),
      errorMessage: null,
      createdAt: demoDate(18, 1),
    },
    {
      id: "demo-inst-charge-2",
      agreementId: "demo-agreement",
      installmentNumber: 2,
      dueDate: demoDate(48),
      amount: 500.0,
      currency: "MAD",
      status: "PENDING",
      chargeId: "inst-demo-agre-2",
      vpsTransactionId: null,
      attemptNumber: 1,
      processedAt: null,
      errorMessage: null,
      createdAt: demoDate(18, 2),
    },
    {
      id: "demo-inst-charge-3",
      agreementId: "demo-agreement",
      installmentNumber: 3,
      dueDate: demoDate(78),
      amount: 500.0,
      currency: "MAD",
      status: "DECLINED",
      chargeId: "inst-demo-agre-3",
      vpsTransactionId: null,
      attemptNumber: 1,
      processedAt: demoDate(78),
      errorMessage: "Card expired",
      createdAt: demoDate(78),
    },
  ];
}

// ─── API keys ───────────────────────────────────────────────────────────────────
// keyHash / keySha256 are computed by the seeder from `rawKey`.

export interface DemoApiKeySpec {
  id: string;
  name: string;
  /** Raw key — shown once. Must start with `cp_live_` or `cp_test_`. */
  rawKey: string;
  revokedAt: Date | null;
}

export function demoApiKeys(): DemoApiKeySpec[] {
  return [
    {
      id: "demo-api-key-active",
      name: "Demo Active Key",
      rawKey: "cp_test_demoactive000000000000000000000000000000000000000000000000",
      revokedAt: null,
    },
    {
      id: "demo-api-key-revoked",
      name: "Demo Revoked Key",
      rawKey: "cp_test_demorevoked000000000000000000000000000000000000000000000000",
      revokedAt: demoDate(30),
    },
  ];
}

// ─── Webhook events ─────────────────────────────────────────────────────────────

export function demoWebhookEvents(): Prisma.WebhookEventUncheckedCreateInput[] {
  return [
    {
      id: "demo-webhook-verified",
      provider: Provider.VPS,
      tenantId: DEMO_TENANT_ID,
      paymentIntentId: "demo-intent-succeeded",
      rawPayload: { id: "vps-tx-succeeded", customerId: "demo-corr-succeeded", status: "CHARGED" },
      headers: { "x-callback-signature": "verified-sig" },
      signatureVerified: true,
      processed: true,
      processingError: null,
      mappedStatus: "SUCCEEDED",
      idempotencyKey: "demo-webhook-ev-verified",
      createdAt: demoDate(10, 8),
    },
    {
      id: "demo-webhook-unverified",
      provider: Provider.VPS,
      tenantId: DEMO_TENANT_ID,
      paymentIntentId: null,
      rawPayload: { id: "vps-tx-unknown", status: "CHARGED" },
      headers: {},
      signatureVerified: false,
      processed: false,
      processingError: "signature_mismatch",
      mappedStatus: null,
      idempotencyKey: "demo-webhook-ev-unverified",
      createdAt: demoDate(11, 4),
    },
    {
      // Demonstrates the SHA-256(rawBody) fallback idempotency key path used
      // when a provider sends no explicit event ID.
      id: "demo-webhook-duplicate",
      provider: Provider.STRIPE,
      tenantId: DEMO_TENANT_ID,
      paymentIntentId: "demo-intent-refunded",
      rawPayload: { id: "evt_demo_dup", type: "payment_intent.succeeded" },
      headers: { "stripe-signature": "sig" },
      signatureVerified: true,
      processed: true,
      processingError: null,
      mappedStatus: "SUCCEEDED",
      idempotencyKey: "demo-webhook-ev-duplicate",
      createdAt: demoDate(10, 10),
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PayFac settlement layer (Phases 3–8) — the money-movement entities.
//
// The demo tenant is a Moroccan marketplace with a manual-payout model: VPS/
// Payzone settles gross, Stripe Connect is international-only, so the platform
// admin pays the tenant out by bank transfer (see `POST /admin/payouts/:id/execute`
// in `src/routes/admin.ts`). The fee schedule (2.9%), rolling reserve (5%) and
// MANUAL payout schedule below are explicit tenant overrides of the marketplace
// preset, matching the deterministic ledger story in `demoLedgerEntries()`.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Fee schedule ───────────────────────────────────────────────────────────────

export function demoFeeSchedules(): Prisma.FeeScheduleUncheckedCreateInput[] {
  return [
    {
      id: "demo-fee-v1",
      tenantId: DEMO_TENANT_ID,
      version: 1,
      name: "Standard 2.9%",
      feeType: "PERCENTAGE",
      flatCents: null,
      percentageBps: 290, // 2.9%
      perMethodCents: null,
      tiersCents: null,
      currency: "MAD",
      isActive: true,
      createdAt: demoDate(0),
    },
  ];
}

// ─── Settlement policy ──────────────────────────────────────────────────────────

export function demoSettlementPolicies(): Prisma.SettlementPolicyUncheckedCreateInput[] {
  return [
    {
      id: "demo-policy-v1",
      tenantId: DEMO_TENANT_ID,
      version: 1,
      name: "Morocco manual payout",
      industry: "marketplace",
      mcc: "5262",
      availabilityMode: "DELAY",
      availabilityDelayDays: 2,
      reserveType: "ROLLING",
      reservePercentageBps: 500, // 5%
      reserveHoldDays: 30,
      reserveFixedCents: null,
      payoutSchedule: "MANUAL",
      payoutMinCents: null,
      reversalFunding: "NET_FROM_AVAILABLE",
      allowNegative: false,
      splittingEnabled: true,
      feeScheduleId: "demo-fee-v1",
      isActive: true,
      createdAt: demoDate(0),
    },
  ];
}

// ─── Merchant onboarding (KYC/KYB gate) ────────────────────────────────────────

export function demoMerchantOnboardings(): Prisma.MerchantOnboardingUncheckedCreateInput[] {
  return [
    {
      id: "demo-onboarding",
      tenantId: DEMO_TENANT_ID,
      status: "APPROVED",
      legalName: "Demo Merchant SARL",
      entityType: "corporation",
      registrationNumber: "MA-000123",
      country: "MA",
      businessAddress: "Boulevard Zerktouni, Casablanca",
      website: "https://demo.ma",
      contactEmail: "compliance@demo.ma",
      industry: "marketplace",
      mcc: "5262",
      riskTier: "MEDIUM",
      submittedAt: demoDate(1),
      reviewerId: "demo-user-admin",
      reviewNotes: "Auto-approved demo tenant.",
      rejectionReason: null,
      approvedAt: demoDate(2),
      createdAt: demoDate(1),
    },
  ];
}

// ─── Ledger (double-entry) ─────────────────────────────────────────────────────
// A balanced, deterministic money story exercising every account and the
// settlement lifecycle end-to-end (capture → settle → fee → reserve → release →
// payout → split → refund → chargeback). `balanceAfter` is computed as the
// running balance per account, so the audit snapshot is correct, not just
// plausible. Amounts are centimes here and written to the MAD `Decimal(12,2)`
// columns below.

interface DemoLedgerLeg {
  id: string;
  account: Prisma.LedgerEntryUncheckedCreateInput["account"];
  direction: Prisma.LedgerEntryUncheckedCreateInput["direction"];
  amountCents: number;
  partyId?: string | null;
}

interface DemoLedgerPosting {
  postingId: string;
  category: Prisma.LedgerEntryUncheckedCreateInput["category"];
  sourceType: string | null;
  sourceId: string | null;
  debit: DemoLedgerLeg;
  credit: DemoLedgerLeg;
}

export function demoLedgerEntries(): Prisma.LedgerEntryUncheckedCreateInput[] {
  const postings: DemoLedgerPosting[] = [
    // Capture #1 — 250.00 MAD (demo-intent-succeeded).
    {
      postingId: "demo-posting-capture-a",
      category: "CAPTURE",
      sourceType: "payment_intent",
      sourceId: "demo-intent-succeeded",
      debit: {
        id: "demo-ledger-pending-a-dr",
        account: "PENDING",
        direction: "DEBIT",
        amountCents: 25000,
      },
      credit: {
        id: "demo-ledger-collected-a-cr",
        account: "COLLECTED",
        direction: "CREDIT",
        amountCents: 25000,
      },
    },
    // Settle: provider released the capture (PENDING → CASH).
    {
      postingId: "demo-posting-settle-a",
      category: "ADJUSTMENT",
      sourceType: null,
      sourceId: null,
      debit: {
        id: "demo-ledger-cash-a-dr",
        account: "CASH",
        direction: "DEBIT",
        amountCents: 25000,
      },
      credit: {
        id: "demo-ledger-pending-a-cr",
        account: "PENDING",
        direction: "CREDIT",
        amountCents: 25000,
      },
    },
    // Fee 2.9% = 725c.
    {
      postingId: "demo-posting-fee-a",
      category: "FEE",
      sourceType: "payment_intent",
      sourceId: "demo-intent-succeeded",
      debit: {
        id: "demo-ledger-fee-a-dr",
        account: "COLLECTED",
        direction: "DEBIT",
        amountCents: 725,
      },
      credit: {
        id: "demo-ledger-fees-a-cr",
        account: "FEES",
        direction: "CREDIT",
        amountCents: 725,
      },
    },
    // Rolling reserve 5% = 1250c.
    {
      postingId: "demo-posting-reserve-a",
      category: "ADJUSTMENT",
      sourceType: "payment_intent",
      sourceId: "demo-intent-succeeded",
      debit: {
        id: "demo-ledger-reserve-a-dr",
        account: "COLLECTED",
        direction: "DEBIT",
        amountCents: 1250,
      },
      credit: {
        id: "demo-ledger-reserve-a-cr",
        account: "RESERVE",
        direction: "CREDIT",
        amountCents: 1250,
      },
    },
    // Release net (25000 − 725 − 1250 = 23025) → AVAILABLE.
    {
      postingId: "demo-posting-release-a",
      category: "ADJUSTMENT",
      sourceType: "payment_intent",
      sourceId: "demo-intent-succeeded",
      debit: {
        id: "demo-ledger-collected-release-a-dr",
        account: "COLLECTED",
        direction: "DEBIT",
        amountCents: 23025,
      },
      credit: {
        id: "demo-ledger-ava-a-cr",
        account: "AVAILABLE",
        direction: "CREDIT",
        amountCents: 23025,
      },
    },
    // Capture #2 — 199.00 MAD (demo-intent-refunded-full).
    {
      postingId: "demo-posting-capture-b",
      category: "CAPTURE",
      sourceType: "payment_intent",
      sourceId: "demo-intent-refunded-full",
      debit: {
        id: "demo-ledger-pending-b-dr",
        account: "PENDING",
        direction: "DEBIT",
        amountCents: 19900,
      },
      credit: {
        id: "demo-ledger-collected-b-cr",
        account: "COLLECTED",
        direction: "CREDIT",
        amountCents: 19900,
      },
    },
    {
      postingId: "demo-posting-settle-b",
      category: "ADJUSTMENT",
      sourceType: null,
      sourceId: null,
      debit: {
        id: "demo-ledger-cash-b-dr",
        account: "CASH",
        direction: "DEBIT",
        amountCents: 19900,
      },
      credit: {
        id: "demo-ledger-pending-b-cr",
        account: "PENDING",
        direction: "CREDIT",
        amountCents: 19900,
      },
    },
    // Fee 2.9% = 577c (rounded).
    {
      postingId: "demo-posting-fee-b",
      category: "FEE",
      sourceType: "payment_intent",
      sourceId: "demo-intent-refunded-full",
      debit: {
        id: "demo-ledger-fee-b-dr",
        account: "COLLECTED",
        direction: "DEBIT",
        amountCents: 577,
      },
      credit: {
        id: "demo-ledger-fees-b-cr",
        account: "FEES",
        direction: "CREDIT",
        amountCents: 577,
      },
    },
    // Reserve 5% = 995c.
    {
      postingId: "demo-posting-reserve-b",
      category: "ADJUSTMENT",
      sourceType: "payment_intent",
      sourceId: "demo-intent-refunded-full",
      debit: {
        id: "demo-ledger-reserve-b-dr",
        account: "COLLECTED",
        direction: "DEBIT",
        amountCents: 995,
      },
      credit: {
        id: "demo-ledger-reserve-b-cr",
        account: "RESERVE",
        direction: "CREDIT",
        amountCents: 995,
      },
    },
    // Release net (19900 − 577 − 995 = 18328) → AVAILABLE.
    {
      postingId: "demo-posting-release-b",
      category: "ADJUSTMENT",
      sourceType: "payment_intent",
      sourceId: "demo-intent-refunded-full",
      debit: {
        id: "demo-ledger-collected-release-b-dr",
        account: "COLLECTED",
        direction: "DEBIT",
        amountCents: 18328,
      },
      credit: {
        id: "demo-ledger-ava-b-cr",
        account: "AVAILABLE",
        direction: "CREDIT",
        amountCents: 18328,
      },
    },
    // Payout (PAID) — drains cycle A's AVAILABLE 230.25 MAD.
    {
      postingId: "demo-posting-payout-a",
      category: "PAYOUT",
      sourceType: "payout",
      sourceId: "demo-payout-paid",
      debit: {
        id: "demo-ledger-payout-a-dr",
        account: "AVAILABLE",
        direction: "DEBIT",
        amountCents: 23025,
      },
      credit: {
        id: "demo-ledger-paidout-cr",
        account: "PAID_OUT",
        direction: "CREDIT",
        amountCents: 23025,
      },
    },
    // Split — 50.00 MAD to the marketplace party (ON_USAGE: AVAILABLE → party AVAILABLE).
    {
      postingId: "demo-posting-split",
      category: "SPLIT",
      sourceType: "payment_intent",
      sourceId: "demo-intent-succeeded",
      debit: {
        id: "demo-ledger-split-dr",
        account: "AVAILABLE",
        direction: "DEBIT",
        amountCents: 5000,
      },
      credit: {
        id: "demo-ledger-split-party-cr",
        account: "AVAILABLE",
        direction: "CREDIT",
        amountCents: 5000,
        partyId: "demo-party-marketplace",
      },
    },
    // Refund — 25.00 MAD partial (reversal-funded from AVAILABLE).
    {
      postingId: "demo-posting-refund",
      category: "REFUND",
      sourceType: "refund",
      sourceId: "demo-refund-partial",
      debit: {
        id: "demo-ledger-refund-dr",
        account: "AVAILABLE",
        direction: "DEBIT",
        amountCents: 2500,
      },
      credit: {
        id: "demo-ledger-refund-cash-cr",
        account: "CASH",
        direction: "CREDIT",
        amountCents: 2500,
      },
    },
    // Chargeback — 30.00 MAD dispute lost.
    {
      postingId: "demo-posting-chargeback",
      category: "CHARGEBACK",
      sourceType: "dispute",
      sourceId: "demo-dispute-1",
      debit: {
        id: "demo-ledger-chargeback-dr",
        account: "AVAILABLE",
        direction: "DEBIT",
        amountCents: 3000,
      },
      credit: {
        id: "demo-ledger-chargeback-cash-cr",
        account: "CASH",
        direction: "CREDIT",
        amountCents: 3000,
      },
    },
  ];

  const balances = new Map<string, number>();
  const rows: Prisma.LedgerEntryUncheckedCreateInput[] = [];
  postings.forEach((posting, index) => {
    // Fixed, increasing timestamp per posting (chronological money movement,
    // no `Date.now()` — keeps the seed deterministic and statement-windowable).
    const createdAt = demoDate(10 + index);
    for (const leg of [posting.debit, posting.credit]) {
      const key = `${leg.account}:${leg.partyId ?? ""}`;
      const delta = leg.direction === "CREDIT" ? leg.amountCents : -leg.amountCents;
      const after = (balances.get(key) ?? 0) + delta;
      balances.set(key, after);
      rows.push({
        id: leg.id,
        postingId: posting.postingId,
        tenantId: DEMO_TENANT_ID,
        account: leg.account,
        direction: leg.direction,
        category: posting.category,
        amount: leg.amountCents / 100,
        currency: "MAD",
        balanceAfter: after / 100,
        sourceType: posting.sourceType,
        sourceId: posting.sourceId,
        partyId: leg.partyId ?? null,
        createdAt,
      });
    }
  });
  return rows;
}

// ─── Payouts + items ────────────────────────────────────────────────────────────
// `demo-payout-paid` drained cycle A (230.25 MAD); `demo-payout-draft` snapshots
// cycle B's AVAILABLE (183.28 MAD) but has not moved money yet.

export function demoPayouts(): Prisma.PayoutUncheckedCreateInput[] {
  return [
    {
      id: "demo-payout-paid",
      tenantId: DEMO_TENANT_ID,
      amount: 230.25,
      currency: "MAD",
      status: "PAID",
      provider: "VPS",
      providerTransferId: "bank-tr-demo-001",
      feeAmount: 0,
      method: "BANK_TRANSFER",
      idempotencyKey: "demo-payout-paid-key",
      createdAt: demoDate(20),
    },
    {
      id: "demo-payout-draft",
      tenantId: DEMO_TENANT_ID,
      amount: 183.28,
      currency: "MAD",
      status: "DRAFT",
      provider: "VPS",
      providerTransferId: null,
      feeAmount: 0,
      method: "BANK_TRANSFER",
      idempotencyKey: "demo-payout-draft-key",
      createdAt: demoDate(21),
    },
  ];
}

export function demoPayoutItems(): Prisma.PayoutItemUncheckedCreateInput[] {
  return [
    {
      id: "demo-payout-item-paid",
      payoutId: "demo-payout-paid",
      ledgerEntryId: "demo-ledger-ava-a-cr",
      amount: 230.25,
    },
    {
      id: "demo-payout-item-draft",
      payoutId: "demo-payout-draft",
      ledgerEntryId: "demo-ledger-ava-b-cr",
      amount: 183.28,
    },
  ];
}

// ─── Dispute + recovery ─────────────────────────────────────────────────────────

export function demoDisputes(): Prisma.DisputeUncheckedCreateInput[] {
  return [
    {
      id: "demo-dispute-1",
      tenantId: DEMO_TENANT_ID,
      paymentIntentId: "demo-intent-succeeded",
      provider: "VPS",
      providerDisputeId: "dp_demo_001",
      status: "LOST",
      amount: 30.0,
      feeAmount: 0,
      currency: "MAD",
      reason: "Product not received",
      evidenceDueDate: demoDate(28),
      createdAt: demoDate(22),
    },
  ];
}

export function demoRecoveries(): Prisma.RecoveryUncheckedCreateInput[] {
  return [
    {
      id: "demo-recovery-1",
      tenantId: DEMO_TENANT_ID,
      disputeId: "demo-dispute-1",
      status: "PENDING", // the uncovered clawback the tenant owes
      amount: 30.0,
      currency: "MAD",
      createdAt: demoDate(22),
    },
  ];
}

// ─── Splits: parties + rule + executed split ────────────────────────────────────

export function demoSplitParties(): Prisma.SplitPartyUncheckedCreateInput[] {
  return [
    {
      id: "demo-party-marketplace",
      tenantId: DEMO_TENANT_ID,
      slug: "marketplace",
      name: "Marketplace Co.",
      type: "SUB_MERCHANT",
      isActive: true,
      createdAt: demoDate(0),
    },
    {
      id: "demo-party-vendor",
      tenantId: DEMO_TENANT_ID,
      slug: "vendor",
      name: "Vendor SARL",
      type: "VENDOR",
      isActive: true,
      createdAt: demoDate(0),
    },
  ];
}

export function demoSplitRules(): Prisma.SplitRuleUncheckedCreateInput[] {
  return [
    {
      id: "demo-split-rule-1",
      tenantId: DEMO_TENANT_ID,
      name: "Marketplace 50/50",
      trigger: "ON_USAGE",
      shares: [{ partyId: "demo-party-marketplace", shareBps: 5000 }],
      isActive: true,
      createdAt: demoDate(0),
    },
  ];
}

export function demoSplits(): Prisma.SplitUncheckedCreateInput[] {
  return [
    {
      id: "demo-split-1",
      tenantId: DEMO_TENANT_ID,
      splitRuleId: "demo-split-rule-1",
      sourceType: "payment_intent",
      sourceId: "demo-intent-succeeded",
      partyId: "demo-party-marketplace",
      amount: 50.0,
      currency: "MAD",
      status: "SETTLED",
      heldUntil: null,
      createdAt: demoDate(19),
    },
  ];
}

// ─── Reconciliation (three-way match) ───────────────────────────────────────────

export function demoReconciliationReports(): Prisma.ReconciliationReportUncheckedCreateInput[] {
  return [
    {
      id: "demo-recon-report-1",
      tenantId: DEMO_TENANT_ID,
      provider: "VPS",
      currency: "MAD",
      periodStart: demoDate(1),
      periodEnd: demoDate(30),
      status: "MATCHED",
      summary: { matched: 2, unmatched: 1, breaks: 0, externalCents: 45900, internalCents: 45900 },
      createdAt: demoDate(30),
    },
  ];
}

export function demoReconciliationLines(): Prisma.ReconciliationLineUncheckedCreateInput[] {
  return [
    {
      id: "demo-recon-line-1",
      reportId: "demo-recon-report-1",
      reference: "vps-tx-succeeded",
      amount: 250.0,
      currency: "MAD",
      status: "EXACT",
      matchedAmount: 250.0,
      differenceAmount: 0,
      createdAt: demoDate(30),
    },
    {
      id: "demo-recon-line-2",
      reportId: "demo-recon-report-1",
      reference: "vps-tx-refunded-full",
      amount: 199.0,
      currency: "MAD",
      status: "EXACT",
      matchedAmount: 199.0,
      differenceAmount: 0,
      createdAt: demoDate(30),
    },
    {
      id: "demo-recon-line-3",
      reportId: "demo-recon-report-1",
      reference: "vps-tx-orphan",
      amount: 10.0,
      currency: "MAD",
      status: "UNMATCHED",
      matchedAmount: null,
      differenceAmount: null,
      createdAt: demoDate(30),
    },
  ];
}

// ─── Settlement statement (invoicing data — the tenant sends the email) ─────────

export function demoSettlementStatements(): Prisma.SettlementStatementUncheckedCreateInput[] {
  return [
    {
      id: "demo-statement-1",
      tenantId: DEMO_TENANT_ID,
      periodStart: demoDate(1),
      periodEnd: demoDate(30),
      currency: "MAD",
      status: "FINALIZED",
      openingBalance: 0,
      // AVAILABLE running balance at period end (matches `getTenantLedger`).
      closingBalance: 128.28,
      netAmount: 128.28,
      finalizedAt: demoDate(30),
      createdAt: demoDate(30),
    },
  ];
}

export function demoSettlementStatementItems(): Prisma.SettlementStatementItemUncheckedCreateInput[] {
  // One item per LedgerCategory present in the window, sorted alphabetically and
  // carrying the category's gross DEBIT volume + posting count — the same shape
  // `buildStatement` emits.
  return [
    {
      id: "demo-statement-item-adjustment",
      statementId: "demo-statement-1",
      category: "ADJUSTMENT",
      amount: 884.98,
      entryCount: 6,
      createdAt: demoDate(30),
    },
    {
      id: "demo-statement-item-capture",
      statementId: "demo-statement-1",
      category: "CAPTURE",
      amount: 449.0,
      entryCount: 2,
      createdAt: demoDate(30),
    },
    {
      id: "demo-statement-item-chargeback",
      statementId: "demo-statement-1",
      category: "CHARGEBACK",
      amount: 30.0,
      entryCount: 1,
      createdAt: demoDate(30),
    },
    {
      id: "demo-statement-item-fee",
      statementId: "demo-statement-1",
      category: "FEE",
      amount: 13.02,
      entryCount: 2,
      createdAt: demoDate(30),
    },
    {
      id: "demo-statement-item-payout",
      statementId: "demo-statement-1",
      category: "PAYOUT",
      amount: 230.25,
      entryCount: 1,
      createdAt: demoDate(30),
    },
    {
      id: "demo-statement-item-refund",
      statementId: "demo-statement-1",
      category: "REFUND",
      amount: 25.0,
      entryCount: 1,
      createdAt: demoDate(30),
    },
    {
      id: "demo-statement-item-split",
      statementId: "demo-statement-1",
      category: "SPLIT",
      amount: 50.0,
      entryCount: 1,
      createdAt: demoDate(30),
    },
  ];
}
