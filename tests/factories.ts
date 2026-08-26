/**
 * factories.ts — shared test data builders.
 *
 * Each `makeX(overrides?)` returns a complete Prisma `UncheckedCreateInput`
 * with sensible defaults, so tests express *intent* (a status + a couple of
 * fields) rather than hand-building rows. Every factory is a pure function —
 * no DB access, no randomness — and is usable from both the unit suite and the
 * DB-backed integration/E2E suite.
 *
 * Amounts follow the money invariant: DB columns are MAD `Decimal(12,2)`, so
 * factory `amount` fields are MAD numbers (e.g. `100` = 100.00 MAD). Tests that
 * need centimes convert through `src/lib/money.ts`, never by hand.
 */

import jwt from "jsonwebtoken";
import {
  AvailabilityMode,
  BillingInterval,
  Environment,
  FeeType,
  InstallmentAgreementStatus,
  PaymentIntentStatus,
  PaymentLinkStatus,
  PayoutMethod,
  PayoutSchedule,
  PayoutStatus,
  Prisma,
  Provider,
  ProviderConfigStatus,
  RefundStatus,
  ReserveType,
  ReversalFundingPolicy,
  SubscriptionStatus,
  UserRole,
} from "@/generated/prisma/client";

// ─── Stable identifiers so integration tests share a consistent fixture set ────

export const TENANT_A_ID = "tenant-a";
export const TENANT_B_ID = "tenant-b";
export const OWNER_ID = "user-owner";
export const STAFF_ID = "user-staff";
export const ADMIN_ID = "user-admin";

// ─── Auth helper ────────────────────────────────────────────────────────────────

/**
 * Mint a signed JWT for RBAC / tenant-isolation tests.
 *
 * Signs with the same `JWT_SECRET` that `middleware/auth.ts` reads, so the
 * token is accepted by `requireAuth` when `process.env.JWT_SECRET` is set to the
 * same value in the test.
 */
export function mintToken(user: {
  id: string;
  tenantId: string;
  role: UserRole;
  email?: string;
}): string {
  const secret = process.env.JWT_SECRET ?? "test-secret";
  return jwt.sign(
    { tenantId: user.tenantId, role: user.role, email: user.email ?? `${user.id}@test.local` },
    secret,
    { subject: user.id, expiresIn: "1h" } as jwt.SignOptions,
  );
}

// ─── Tenant ──────────────────────────────────────────────────────────────────────

export function makeTenant(overrides: Partial<Prisma.TenantUncheckedCreateInput> = {}) {
  const data: Prisma.TenantUncheckedCreateInput = {
    id: TENANT_A_ID,
    name: "Tenant A",
    slug: "tenant-a",
    status: "ACTIVE",
    environment: Environment.SANDBOX,
    notifyEmail: null,
    notifyWebhookUrl: null,
    ...overrides,
  };
  return data;
}

// ─── User ────────────────────────────────────────────────────────────────────────

export function makeUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const data: Prisma.UserUncheckedCreateInput = {
    id: OWNER_ID,
    tenantId: TENANT_A_ID,
    email: "owner@tenant-a.local",
    passwordHash: "hashed-password",
    role: UserRole.OWNER,
    ...overrides,
  };
  return data;
}

// ─── Provider config ─────────────────────────────────────────────────────────────

export function makeProviderConfig(
  overrides: Partial<Prisma.ProviderConfigUncheckedCreateInput> = {},
) {
  const data: Prisma.ProviderConfigUncheckedCreateInput = {
    id: "provider-config-vps",
    tenantId: TENANT_A_ID,
    provider: Provider.VPS,
    encryptedCredentials: "v2:encrypted-credentials",
    status: ProviderConfigStatus.CONNECTED,
    environment: Environment.SANDBOX,
    ...overrides,
  };
  return data;
}

// ─── Payment link ────────────────────────────────────────────────────────────────

export function makePaymentLink(overrides: Partial<Prisma.PaymentLinkUncheckedCreateInput> = {}) {
  const data: Prisma.PaymentLinkUncheckedCreateInput = {
    id: "link-1",
    tenantId: TENANT_A_ID,
    slug: "link-1",
    amount: 100, // 100.00 MAD
    currency: "MAD",
    description: "Test payment link",
    reference: "REF-1",
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    provider: Provider.VPS,
    status: PaymentLinkStatus.ACTIVE,
    maxAttempts: 1,
    attemptCount: 0,
    expiresAt: null,
    isRecurring: false,
    billingInterval: null,
    intervalValue: 1,
    maxRetries: 3,
    isInstallment: false,
    ...overrides,
  };
  return data;
}

// ─── Payment intent ──────────────────────────────────────────────────────────────

export function makePaymentIntent(
  overrides: Partial<Prisma.PaymentIntentUncheckedCreateInput> = {},
) {
  const data: Prisma.PaymentIntentUncheckedCreateInput = {
    id: "intent-1",
    tenantId: TENANT_A_ID,
    paymentLinkId: "link-1",
    status: PaymentIntentStatus.CREATED,
    provider: Provider.VPS,
    providerRef: null,
    correlationId: "corr-1",
    providerData: Prisma.DbNull,
    customerIp: null,
    metadata: Prisma.DbNull,
    ...overrides,
  };
  return data;
}

// ─── Provider transaction ────────────────────────────────────────────────────────

export function makeProviderTransaction(
  overrides: Partial<Prisma.ProviderTransactionUncheckedCreateInput> = {},
) {
  const data: Prisma.ProviderTransactionUncheckedCreateInput = {
    id: "ptx-1",
    paymentIntentId: "intent-1",
    provider: Provider.VPS,
    providerTransactionId: "vps-tx-1",
    rawRequest: Prisma.DbNull,
    rawResponse: Prisma.DbNull,
    ...overrides,
  };
  return data;
}

// ─── Refund ──────────────────────────────────────────────────────────────────────

export function makeRefund(overrides: Partial<Prisma.RefundUncheckedCreateInput> = {}) {
  const data: Prisma.RefundUncheckedCreateInput = {
    id: "refund-1",
    paymentIntentId: "intent-1",
    tenantId: TENANT_A_ID,
    initiatedBy: OWNER_ID,
    status: RefundStatus.SUCCEEDED,
    providerRefundRef: "refund-ref-1",
    amount: 100,
    currency: "MAD",
    ...overrides,
  };
  return data;
}

// ─── Subscription ────────────────────────────────────────────────────────────────

export function makeSubscription(overrides: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) {
  const data: Prisma.SubscriptionUncheckedCreateInput = {
    id: "sub-1",
    tenantId: TENANT_A_ID,
    customerId: "cust-1",
    encryptedStoredProfileId: "v2:profile",
    initialPaymentIntentId: "intent-1",
    paymentLinkId: "link-1",
    inngestRunId: null,
    status: SubscriptionStatus.ACTIVE,
    amount: 99,
    currency: "MAD",
    intervalType: BillingInterval.MONTHLY,
    intervalValue: 1,
    nextBillingDate: new Date("2026-02-01T00:00:00Z"),
    currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
    trialEndDate: null,
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
  return data;
}

// ─── Billing event ───────────────────────────────────────────────────────────────

export function makeBillingEvent(overrides: Partial<Prisma.BillingEventUncheckedCreateInput> = {}) {
  const data: Prisma.BillingEventUncheckedCreateInput = {
    id: "billing-event-1",
    subscriptionId: "sub-1",
    chargeId: "renewal-1",
    vpsTransactionId: null,
    inngestRunId: null,
    amount: 99,
    currency: "MAD",
    status: "CHARGED",
    attemptNumber: 1,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    processedAt: null,
    errorMessage: null,
    ...overrides,
  };
  return data;
}

// ─── Installment plan ────────────────────────────────────────────────────────────

export function makeInstallmentPlan(
  overrides: Partial<Prisma.InstallmentPlanUncheckedCreateInput> = {},
) {
  const data: Prisma.InstallmentPlanUncheckedCreateInput = {
    id: "plan-1",
    tenantId: TENANT_A_ID,
    name: "Pay in 3",
    durationMonths: 3,
    annualInterestRate: 0,
    minAmount: null,
    maxAmount: null,
    isActive: true,
    ...overrides,
  };
  return data;
}

// ─── Installment agreement ───────────────────────────────────────────────────────

export function makeInstallmentAgreement(
  overrides: Partial<Prisma.InstallmentAgreementUncheckedCreateInput> = {},
) {
  const data: Prisma.InstallmentAgreementUncheckedCreateInput = {
    id: "agreement-1",
    tenantId: TENANT_A_ID,
    customerId: "cust-1",
    planId: "plan-1",
    paymentLinkId: "link-1",
    initialPaymentIntentId: "intent-1",
    encryptedStoredProfileId: "v2:profile",
    status: InstallmentAgreementStatus.ACTIVE,
    principalAmount: 1500,
    downPayment: 500,
    installmentAmount: 500,
    totalInstallments: 3,
    paidCount: 1,
    currency: "MAD",
    nextChargeDate: new Date("2026-02-01T00:00:00Z"),
    inngestRunId: null,
    ...overrides,
  };
  return data;
}

// ─── Installment charge ──────────────────────────────────────────────────────────

export function makeInstallmentCharge(
  overrides: Partial<Prisma.InstallmentChargeUncheckedCreateInput> = {},
) {
  const data: Prisma.InstallmentChargeUncheckedCreateInput = {
    id: "charge-1",
    agreementId: "agreement-1",
    installmentNumber: 1,
    dueDate: new Date("2026-01-01T00:00:00Z"),
    amount: 500,
    currency: "MAD",
    status: "CHARGED",
    chargeId: "charge-1",
    vpsTransactionId: null,
    attemptNumber: 1,
    processedAt: null,
    errorMessage: null,
    ...overrides,
  };
  return data;
}

// ─── API key ─────────────────────────────────────────────────────────────────────

export function makeApiKey(overrides: Partial<Prisma.ApiKeyUncheckedCreateInput> = {}) {
  const data: Prisma.ApiKeyUncheckedCreateInput = {
    id: "api-key-1",
    tenantId: TENANT_A_ID,
    name: "Test Key",
    keyHash: "bcrypt-hash",
    keySha256: "sha256-hash",
    keyPrefix: "cp_test_00000000",
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
  return data;
}

// ─── Webhook event ───────────────────────────────────────────────────────────────

export function makeWebhookEvent(overrides: Partial<Prisma.WebhookEventUncheckedCreateInput> = {}) {
  const data: Prisma.WebhookEventUncheckedCreateInput = {
    id: "webhook-event-1",
    provider: Provider.VPS,
    tenantId: TENANT_A_ID,
    paymentIntentId: "intent-1",
    rawPayload: { status: "CHARGED" },
    headers: {},
    signatureVerified: true,
    processed: true,
    processingError: null,
    mappedStatus: "SUCCEEDED",
    idempotencyKey: "webhook-idem-1",
    ...overrides,
  };
  return data;
}

// ─── Fee schedule ────────────────────────────────────────────────────────────────

export function makeFeeSchedule(overrides: Partial<Prisma.FeeScheduleUncheckedCreateInput> = {}) {
  const data: Prisma.FeeScheduleUncheckedCreateInput = {
    id: "fee-schedule-1",
    tenantId: TENANT_A_ID,
    version: 1,
    name: null,
    feeType: FeeType.PERCENTAGE,
    flatCents: null,
    percentageBps: 290,
    perMethodCents: null,
    tiersCents: null,
    currency: "MAD",
    isActive: true,
    ...overrides,
  };
  return data;
}

// ─── Settlement policy ───────────────────────────────────────────────────────────

export function makeSettlementPolicy(
  overrides: Partial<Prisma.SettlementPolicyUncheckedCreateInput> = {},
) {
  const data: Prisma.SettlementPolicyUncheckedCreateInput = {
    id: "settlement-policy-1",
    tenantId: TENANT_A_ID,
    version: 1,
    name: null,
    industry: "saas",
    mcc: null,
    availabilityMode: AvailabilityMode.IMMEDIATE,
    availabilityDelayDays: null,
    reserveType: ReserveType.NONE,
    reservePercentageBps: null,
    reserveHoldDays: null,
    reserveFixedCents: null,
    payoutSchedule: PayoutSchedule.AUTO_DAILY,
    payoutMinCents: null,
    reversalFunding: ReversalFundingPolicy.NET_FROM_AVAILABLE,
    allowNegative: false,
    splittingEnabled: false,
    feeScheduleId: null,
    isActive: true,
    ...overrides,
  };
  return data;
}

// ─── Payout ─────────────────────────────────────────────────────────────────────

export function makePayout(overrides: Partial<Prisma.PayoutUncheckedCreateInput> = {}) {
  const data: Prisma.PayoutUncheckedCreateInput = {
    id: "payout-1",
    tenantId: TENANT_A_ID,
    amount: 100, // 100.00 MAD
    currency: "MAD",
    status: PayoutStatus.DRAFT,
    provider: Provider.VPS,
    providerTransferId: null,
    feeAmount: 0,
    method: PayoutMethod.BANK_TRANSFER,
    idempotencyKey: "payout-idem-1",
    ...overrides,
  };
  return data;
}

// ─── Payout item ────────────────────────────────────────────────────────────────

export function makePayoutItem(overrides: Partial<Prisma.PayoutItemUncheckedCreateInput> = {}) {
  const data: Prisma.PayoutItemUncheckedCreateInput = {
    id: "payout-item-1",
    payoutId: "payout-1",
    ledgerEntryId: "ledger-entry-1",
    amount: 100,
    ...overrides,
  };
  return data;
}
