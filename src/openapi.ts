import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { providerHealthSchema, tenantStatusSchema } from "./schemas/admin";
import { createApiKeySchema } from "./schemas/api-keys";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "./schemas/auth";
import { createDisputeSchema, resolveDisputeSchema } from "./schemas/disputes";
import { createFeeScheduleSchema } from "./schemas/fee-schedules";
import { planSchema } from "./schemas/installment-plans";
import { createIntentSchema, paySchema } from "./schemas/payment-intents";
import { createPaymentLinkSchema } from "./schemas/payment-links";
import { createPayoutSchema } from "./schemas/payouts";
import { providerConfigStatusSchema } from "./schemas/provider-config";
import { createReconciliationReportSchema } from "./schemas/reconciliation";
import { createSettlementPolicySchema } from "./schemas/settlement-policies";
import {
  bnplFireSchema,
  bnplPrepareSchema,
  prepareSchema,
  startSchema,
} from "./schemas/simulation";
import {
  createSplitPartySchema,
  createSplitRuleSchema,
  executeSplitSchema,
} from "./schemas/splits";
import { updateTenantSchema } from "./schemas/tenant";
import { changeRoleSchema, inviteSchema } from "./schemas/users";

extendZodWithOpenApi(z);

/**
 * OpenAPI registry — the single source of truth for the API contract.
 * The web app consumes the generated `openapi.json` via `openapi-typescript`.
 */
export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Prisma `Decimal` fields serialize as JSON *strings* when returned raw, while
// handlers that explicitly `Number()` them emit numbers. Model money as a
// number|string union so the generated client matches the web app's
// `formatAmount(amount: number | string)` usage.
const Money = z.union([z.number(), z.string()]);
const NullableMoney = Money.nullable();
// Prisma `Json` columns (metadata, providerData, rawPayload, ...) are opaque maps.
const Json = z.record(z.unknown());
const NullableJson = Json.nullable();

function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  });
}

// ─── Components ─────────────────────────────────────────────────────────────────

const HealthResponse = registry.register(
  "HealthResponse",
  z.object({
    status: z.string().openapi({ example: "ok" }),
    time: z.string().openapi({ example: "2026-08-22T00:00:00.000Z" }),
  }),
);

const Tenant = registry.register(
  "Tenant",
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    environment: z.string(),
  }),
);

const User = registry.register(
  "User",
  z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
  }),
);

const LoginRequest = registry.register("LoginRequest", loginSchema);

const RegisterRequest = registry.register("RegisterRequest", registerSchema);

const AuthResponse = registry.register(
  "AuthResponse",
  z.object({
    token: z.string(),
    tenant: Tenant,
    user: User,
  }),
);

const MeResponse = registry.register(
  "MeResponse",
  z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    createdAt: z.string(),
    tenant: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      environment: z.string(),
      status: z.string(),
    }),
  }),
);

const TenantProfile = registry.register(
  "TenantProfile",
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    environment: z.string(),
    createdAt: z.string(),
    notifyWebhookUrl: z.string().nullable(),
    notifyEmail: z.string().nullable(),
  }),
);

const TenantUpdateResponse = registry.register(
  "TenantUpdateResponse",
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    notifyWebhookUrl: z.string().nullable(),
    notifyEmail: z.string().nullable(),
  }),
);

const UserListItem = registry.register(
  "UserListItem",
  z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    createdAt: z.string(),
  }),
);

const ProviderConfigListItem = registry.register(
  "ProviderConfigListItem",
  z.object({
    id: z.string(),
    provider: z.string(),
    status: z.string(),
    environment: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    credentials: Json,
  }),
);

const ProviderConfigUpsertResponse = registry.register(
  "ProviderConfigUpsertResponse",
  z.object({
    id: z.string(),
    provider: z.string(),
    status: z.string(),
    warnings: z.array(z.string()),
  }),
);

const ProviderTestResponse = registry.register(
  "ProviderTestResponse",
  z.object({
    connected: z.boolean(),
    status: z.string(),
    error: z.string().nullable(),
  }),
);

const PaymentLinkCreateResponse = registry.register(
  "PaymentLinkCreateResponse",
  z.object({
    id: z.string(),
    slug: z.string(),
    url: z.string(),
    amount: Money,
    currency: z.string(),
    description: z.string(),
    reference: z.string(),
    status: z.string(),
    isRecurring: z.boolean(),
    billingInterval: z.string().nullable(),
    intervalValue: z.number().nullable(),
    createdAt: z.string(),
  }),
);

const PaymentLinkListItem = registry.register(
  "PaymentLinkListItem",
  z.object({
    id: z.string(),
    slug: z.string(),
    url: z.string(),
    amount: Money,
    currency: z.string(),
    description: z.string(),
    reference: z.string(),
    provider: z.string(),
    status: z.string(),
    attemptCount: z.number(),
    maxAttempts: z.number(),
    expiresAt: z.string().nullable(),
    isRecurring: z.boolean(),
    billingInterval: z.string().nullable(),
    intervalValue: z.number().nullable(),
    createdAt: z.string(),
  }),
);

const PaymentLinkDetail = registry.register(
  "PaymentLinkDetail",
  z.object({
    id: z.string(),
    tenantId: z.string(),
    slug: z.string(),
    amount: Money,
    currency: z.string(),
    description: z.string(),
    reference: z.string(),
    customerName: z.string().nullable(),
    customerEmail: z.string().nullable(),
    customerPhone: z.string().nullable(),
    provider: z.string(),
    status: z.string(),
    maxAttempts: z.number(),
    attemptCount: z.number(),
    expiresAt: z.string().nullable(),
    isRecurring: z.boolean(),
    billingInterval: z.string().nullable(),
    intervalValue: z.number().nullable(),
    maxRetries: z.number(),
    isInstallment: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    url: z.string(),
    _count: z.object({ paymentIntents: z.number() }),
  }),
);

const PublicCheckoutResponse = registry.register(
  "PublicCheckoutResponse",
  z.object({
    slug: z.string(),
    merchantName: z.string(),
    amount: Money,
    currency: z.string(),
    description: z.string(),
    customerName: z.string().nullable(),
    customerEmail: z.string().nullable(),
    customerPhone: z.string().nullable(),
    provider: z.string(),
    isRecurring: z.boolean(),
    isInstallment: z.boolean(),
    billingInterval: z.string().nullable(),
    intervalValue: z.number().nullable(),
  }),
);

const WebhookAck = registry.register(
  "WebhookAck",
  z.object({
    received: z.boolean(),
    duplicate: z.boolean().optional(),
  }),
);

const CreateIntentRequest = registry.register("CreateIntentRequest", createIntentSchema);

const CreateIntentResponse = registry.register(
  "CreateIntentResponse",
  z.object({
    intentId: z.string(),
    correlationId: z.string(),
    checkoutUrl: z.string(),
    redirectUrl: z.string().nullable(),
    providerData: NullableJson,
    stripeData: z
      .object({
        clientSecret: z.string(),
        publishableKey: z.string(),
      })
      .nullable(),
    idempotent: z.boolean().optional(),
  }),
);

const IntentStatusResponse = registry.register(
  "IntentStatusResponse",
  z.object({
    status: z.string(),
    providerRef: z.string().nullable(),
  }),
);

const IntentActionResult = registry.register(
  "IntentActionResult",
  z.object({
    intentId: z.string(),
    status: z.string(),
  }),
);

const PayRequest = registry.register("PayRequest", paySchema);

const PayResponse = registry.register(
  "PayResponse",
  z.object({
    intentId: z.string(),
    agreementId: z.string().optional(),
    redirectUrl: z.string(),
    providerData: NullableJson,
  }),
);

const PublicRelayResponse = registry.register(
  "PublicRelayResponse",
  z.object({
    status: z.string(),
    providerData: z
      .object({
        paywallUrl: z.string().optional(),
        payload: z.string().optional(),
        signature: z.string().optional(),
        mode: z.string().optional(),
        chargeId: z.string().optional(),
        redirectUrl: z.string().optional(),
      })
      .nullable(),
  }),
);

const Transaction = registry.register(
  "Transaction",
  z.object({
    id: z.string(),
    correlationId: z.string(),
    status: z.string(),
    provider: z.string(),
    providerRef: z.string().nullable(),
    providerTransactionId: z.string().nullable(),
    amount: NullableMoney,
    currency: z.string().nullable(),
    paymentLink: z
      .object({
        title: z.string().nullable(),
        slug: z.string(),
      })
      .nullable(),
    reference: z.string().nullable(),
    description: z.string().nullable(),
    hasRefund: z.boolean(),
    refundStatus: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const TransactionDetail = registry.register(
  "TransactionDetail",
  z.object({
    id: z.string(),
    tenantId: z.string(),
    paymentLinkId: z.string().nullable(),
    status: z.string(),
    provider: z.string(),
    providerRef: z.string().nullable(),
    correlationId: z.string(),
    providerData: NullableJson,
    customerIp: z.string().nullable(),
    metadata: NullableJson,
    createdAt: z.string(),
    updatedAt: z.string(),
    paymentLink: z
      .object({
        id: z.string(),
        slug: z.string(),
        amount: Money,
        currency: z.string(),
        description: z.string(),
        reference: z.string(),
        customerName: z.string().nullable(),
        customerEmail: z.string().nullable(),
        customerPhone: z.string().nullable(),
        provider: z.string(),
        status: z.string(),
        createdAt: z.string(),
      })
      .nullable(),
    providerTxs: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        providerTransactionId: z.string().nullable(),
        rawResponse: Json,
        createdAt: z.string(),
      }),
    ),
    refunds: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        amount: Money,
        currency: z.string(),
        providerRefundRef: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
    webhookEvents: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        signatureVerified: z.boolean(),
        processed: z.boolean(),
        mappedStatus: z.string().nullable(),
        processingError: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    amount: NullableMoney,
    currency: z.string().nullable(),
    timeline: z.array(
      z.object({
        type: z.string(),
        timestamp: z.string(),
        detail: z.string(),
      }),
    ),
  }),
);

const PaymentIntentDetail = registry.register(
  "PaymentIntentDetail",
  z.object({
    id: z.string(),
    tenantId: z.string(),
    paymentLinkId: z.string().nullable(),
    status: z.string(),
    provider: z.string(),
    providerRef: z.string().nullable(),
    correlationId: z.string(),
    providerData: NullableJson,
    customerIp: z.string().nullable(),
    metadata: NullableJson,
    createdAt: z.string(),
    updatedAt: z.string(),
    paymentLink: z
      .object({
        slug: z.string(),
        amount: Money,
        currency: z.string(),
        description: z.string(),
        reference: z.string(),
        customerName: z.string().nullable(),
        customerEmail: z.string().nullable(),
        customerPhone: z.string().nullable(),
      })
      .nullable(),
    providerTxs: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        providerTransactionId: z.string().nullable(),
        rawResponse: Json,
        createdAt: z.string(),
      }),
    ),
    refunds: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        amount: Money,
        createdAt: z.string(),
      }),
    ),
    webhookEvents: z.array(
      z.object({
        id: z.string(),
        signatureVerified: z.boolean(),
        processed: z.boolean(),
        mappedStatus: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
);

const RefundResponse = registry.register(
  "RefundResponse",
  z.object({
    id: z.string(),
    status: z.string(),
    amount: Money,
    currency: z.string(),
    providerRefundRef: z.string().nullable(),
  }),
);

const DashboardSummary = registry.register(
  "DashboardSummary",
  z.object({
    today: z.object({
      count: z.number(),
      total: z.number(),
      currency: z.string(),
    }),
    thisWeek: z.object({
      count: z.number(),
      total: z.number(),
      currency: z.string(),
    }),
    payoutStatus: z.string(),
  }),
);

const ApiKeyListItem = registry.register(
  "ApiKeyListItem",
  z.object({
    id: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const ApiKeyCreateResponse = registry.register(
  "ApiKeyCreateResponse",
  z.object({
    id: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    rawKey: z.string(),
    createdAt: z.string(),
  }),
);

const BillingEvent = registry.register(
  "BillingEvent",
  z.object({
    id: z.string(),
    chargeId: z.string(),
    status: z.string(),
    amount: Money,
    currency: z.string(),
    attemptNumber: z.number(),
    billingPeriodStart: z.string().nullable(),
    billingPeriodEnd: z.string().nullable(),
    processedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    vpsTransactionId: z.string().nullable(),
  }),
);

const SubscriptionListItem = registry.register(
  "SubscriptionListItem",
  z.object({
    id: z.string(),
    customerId: z.string(),
    status: z.string(),
    amount: Money,
    currency: z.string(),
    intervalType: z.string(),
    intervalValue: z.number(),
    nextBillingDate: z.string().nullable(),
    retryCount: z.number(),
    billingEventCount: z.number(),
    createdAt: z.string(),
  }),
);

const SubscriptionDetail = registry.register(
  "SubscriptionDetail",
  z.object({
    id: z.string(),
    tenantId: z.string(),
    customerId: z.string(),
    initialPaymentIntentId: z.string(),
    paymentLinkId: z.string().nullable(),
    inngestRunId: z.string().nullable(),
    status: z.string(),
    amount: Money,
    currency: z.string(),
    intervalType: z.string(),
    intervalValue: z.number(),
    nextBillingDate: z.string().nullable(),
    currentPeriodStart: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
    trialEndDate: z.string().nullable(),
    retryCount: z.number(),
    maxRetries: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    billingEvents: z.array(BillingEvent),
  }),
);

const InstallmentPlanListItem = registry.register(
  "InstallmentPlanListItem",
  z.object({
    id: z.string(),
    name: z.string(),
    durationMonths: z.number(),
    annualInterestRate: z.number(),
    minAmount: z.number().nullable(),
    maxAmount: z.number().nullable(),
    isActive: z.boolean(),
    agreementCount: z.number(),
    createdAt: z.string(),
  }),
);

// Raw Prisma InstallmentPlan (returned verbatim by create/update). Decimal
// columns serialize as strings, hence Money for rate/amounts.
const InstallmentPlan = registry.register(
  "InstallmentPlan",
  z.object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string(),
    durationMonths: z.number(),
    annualInterestRate: Money,
    minAmount: NullableMoney,
    maxAmount: NullableMoney,
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const InstallmentPlanSummary = registry.register(
  "InstallmentPlanSummary",
  z.object({
    name: z.string(),
    durationMonths: z.number(),
    annualInterestRate: Money,
  }),
);

const InstallmentCharge = registry.register(
  "InstallmentCharge",
  z.object({
    id: z.string(),
    installmentNumber: z.number(),
    amount: Money,
    currency: z.string(),
    status: z.string(),
    attemptNumber: z.number(),
    processedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }),
);

const InstallmentAgreementListItem = registry.register(
  "InstallmentAgreementListItem",
  z.object({
    id: z.string(),
    customerId: z.string(),
    plan: InstallmentPlanSummary,
    status: z.string(),
    principalAmount: z.number(),
    downPayment: z.number(),
    installmentAmount: z.number(),
    totalInstallments: z.number(),
    paidCount: z.number(),
    currency: z.string(),
    nextChargeDate: z.string().nullable(),
    chargeCount: z.number(),
    createdAt: z.string(),
  }),
);

const InstallmentAgreementDetail = registry.register(
  "InstallmentAgreementDetail",
  z.object({
    id: z.string(),
    tenantId: z.string(),
    customerId: z.string(),
    planId: z.string(),
    paymentLinkId: z.string().nullable(),
    initialPaymentIntentId: z.string(),
    status: z.string(),
    principalAmount: z.number(),
    downPayment: z.number(),
    installmentAmount: z.number(),
    totalInstallments: z.number(),
    paidCount: z.number(),
    currency: z.string(),
    nextChargeDate: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    plan: InstallmentPlanSummary,
    installmentCharges: z.array(InstallmentCharge),
  }),
);

const AdminTenantListItem = registry.register(
  "AdminTenantListItem",
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    environment: z.string(),
    createdAt: z.string(),
    transactionCount: z.number(),
    providerConfigs: z.array(z.object({ provider: z.string(), status: z.string() })),
    lastTransactionAt: z.string().nullable(),
  }),
);

const AdminTenantDetail = registry.register(
  "AdminTenantDetail",
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    environment: z.string(),
    notifyEmail: z.string().nullable(),
    notifyWebhookUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    users: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        role: z.string(),
        createdAt: z.string(),
      }),
    ),
    providerConfigs: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        status: z.string(),
        environment: z.string(),
        updatedAt: z.string(),
      }),
    ),
  }),
);

const AdminWebhookEvent = registry.register(
  "AdminWebhookEvent",
  z.object({
    id: z.string(),
    provider: z.string(),
    tenantId: z.string().nullable(),
    paymentIntentId: z.string().nullable(),
    signatureVerified: z.boolean(),
    processed: z.boolean(),
    processingError: z.string().nullable(),
    mappedStatus: z.string().nullable(),
    idempotencyKey: z.string().nullable(),
    createdAt: z.string(),
    rawPayload: Json,
  }),
);

const ProviderHealthRecord = registry.register(
  "ProviderHealthRecord",
  z.object({
    id: z.string(),
    provider: z.string(),
    status: z.string(),
    notes: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
);

const AdminVpsTenant = registry.register(
  "AdminVpsTenant",
  z.object({
    id: z.string(),
    name: z.string(),
  }),
);

// The raw Prisma `PaymentIntent` returned by `GET /admin/payments/search`,
// with its `paymentLink`, `providerTxs`, `refunds` and `webhookEvents` includes.
const AdminPaymentSearchIntent = z.object({
  id: z.string(),
  tenantId: z.string(),
  paymentLinkId: z.string().nullable(),
  status: z.string(),
  provider: z.string(),
  providerRef: z.string().nullable(),
  correlationId: z.string(),
  providerData: NullableJson,
  customerIp: z.string().nullable(),
  metadata: NullableJson,
  createdAt: z.string(),
  updatedAt: z.string(),
  paymentLink: z
    .object({
      id: z.string(),
      slug: z.string(),
      amount: Money,
      currency: z.string(),
      description: z.string(),
      reference: z.string(),
      customerName: z.string().nullable(),
      customerEmail: z.string().nullable(),
      customerPhone: z.string().nullable(),
      provider: z.string(),
      status: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
  providerTxs: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      providerTransactionId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  refunds: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      amount: Money,
      currency: z.string(),
      providerRefundRef: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  webhookEvents: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      signatureVerified: z.boolean(),
      processed: z.boolean(),
      mappedStatus: z.string().nullable(),
      processingError: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

// ─── Paths ──────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/health",
  operationId: "healthCheck",
  summary: "Health check",
  tags: ["Public"],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

// ─── Public checkout / pay / installment-plans / relay ─────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/checkout/{slug}",
  operationId: "publicCheckout",
  summary: "Fetch a public checkout payment link",
  tags: ["Public"],
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PublicCheckoutResponse } },
    },
    404: { description: "Payment link not found" },
    410: { description: "Link canceled / paid / expired" },
  },
});

registry.registerPath({
  method: "post",
  path: "/public/checkout/{slug}/pay",
  operationId: "publicPay",
  summary: "Create a payment intent from a payment link",
  tags: ["Public"],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: { "application/json": { schema: PayRequest } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PayResponse } },
    },
    400: { description: "Plan required / amount constraints" },
    404: { description: "Payment link not found" },
    410: { description: "Link inactive / expired" },
    429: { description: "Maximum payment attempts reached" },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/installment-plans/{slug}",
  operationId: "publicInstallmentPlans",
  summary: "List active installment plans for a checkout link",
  tags: ["Public"],
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            currency: z.string(),
            principal: Money,
            plans: z.array(
              z.object({
                planId: z.string(),
                name: z.string(),
                durationMonths: z.number(),
                annualInterestRate: z.number(),
                installmentAmount: z.number(),
                totalAmount: z.number(),
                totalInterest: z.number(),
                minAmount: z.number().nullable(),
                maxAmount: z.number().nullable(),
              }),
            ),
          }),
        },
      },
    },
    400: { description: "Not an installment link" },
    404: { description: "Payment link not found" },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/pay/{correlationId}",
  operationId: "publicRelay",
  summary: "Fetch persisted provider data for the hosted relay page",
  tags: ["Public"],
  request: {
    params: z.object({ correlationId: z.string() }),
  },
  responses: {
    200: {
      description: "OK (JSON for API clients; HTML for browsers)",
      content: { "application/json": { schema: PublicRelayResponse } },
    },
    404: { description: "Payment session not found" },
  },
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

const webhookBody = { content: { "application/json": { schema: Json } } };

for (const provider of ["naps", "vps", "stripe"] as const) {
  registry.registerPath({
    method: "post",
    path: `/webhooks/${provider}`,
    operationId: `${provider}Webhook`,
    summary: `${provider.toUpperCase()} provider webhook`,
    tags: ["Webhooks"],
    request: { body: webhookBody },
    responses: {
      200: {
        description: "Received (and possibly deduplicated)",
        content: { "application/json": { schema: WebhookAck } },
      },
      400: { description: "Invalid JSON payload" },
      401: { description: "Invalid webhook signature" },
    },
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/auth/login",
  operationId: "login",
  summary: "Login and get a JWT",
  tags: ["Auth"],
  request: {
    body: { content: { "application/json": { schema: LoginRequest } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AuthResponse } },
    },
    401: { description: "Invalid credentials" },
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/register",
  operationId: "register",
  summary: "Register a new merchant (creates a tenant)",
  tags: ["Auth"],
  request: {
    body: { content: { "application/json": { schema: RegisterRequest } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: AuthResponse } },
    },
    409: { description: "Email already taken" },
  },
});

registry.registerPath({
  method: "get",
  path: "/auth/me",
  operationId: "getMe",
  summary: "Get the authenticated user",
  tags: ["Auth"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MeResponse } },
    },
    401: { description: "Unauthenticated" },
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/forgot-password",
  operationId: "forgotPassword",
  summary: "Request a password reset",
  tags: ["Auth"],
  request: {
    body: {
      content: {
        "application/json": { schema: forgotPasswordSchema },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ message: z.string() }) },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/reset-password",
  operationId: "resetPassword",
  summary: "Reset password with a token",
  tags: ["Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: resetPasswordSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ message: z.string() }) },
      },
    },
  },
});

// ─── Tenant ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/tenant",
  operationId: "getTenant",
  summary: "Get the current tenant profile",
  tags: ["Tenant"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: TenantProfile } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/tenant",
  operationId: "updateTenant",
  summary: "Update the current tenant",
  tags: ["Tenant"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: updateTenantSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: TenantUpdateResponse } },
    },
  },
});

// ─── Users ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/users",
  operationId: "listUsers",
  summary: "List tenant users",
  tags: ["Users"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.array(UserListItem) },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/users/invite",
  operationId: "inviteUser",
  summary: "Invite a user to the tenant",
  tags: ["Users"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: inviteSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: User } },
    },
    409: { description: "Email already taken" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/users/{id}/role",
  operationId: "changeUserRole",
  summary: "Change a user's role",
  tags: ["Users"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: changeRoleSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: User } },
    },
    400: { description: "Cannot remove the only owner" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/users/{id}",
  operationId: "deleteUser",
  summary: "Delete a user",
  tags: ["Users"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: { description: "No Content" },
    400: { description: "Cannot delete self" },
  },
});

// ─── Provider configs ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/provider-configs",
  operationId: "listProviderConfigs",
  summary: "List the tenant's provider configs",
  tags: ["Provider Configs"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.array(ProviderConfigListItem) },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/provider-configs",
  operationId: "upsertProviderConfig",
  summary: "Create or update a provider config",
  tags: ["Provider Configs"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.enum(["NAPS", "VPS", "STRIPE"]),
            environment: z.string().optional(),
            credentials: Json.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ProviderConfigUpsertResponse } },
    },
    400: { description: "Invalid credentials / unsafe test config" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/provider-configs/{id}/status",
  operationId: "setProviderConfigStatus",
  summary: "Enable or disable a provider config",
  tags: ["Provider Configs"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: providerConfigStatusSchema },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            provider: z.string(),
            status: z.string(),
          }),
        },
      },
    },
    404: { description: "Config not found" },
    409: { description: "Config not tested / invalid" },
  },
});

registry.registerPath({
  method: "post",
  path: "/provider-configs/{id}/test",
  operationId: "testProviderConfig",
  summary: "Test a provider config connection",
  tags: ["Provider Configs"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ProviderTestResponse } },
    },
    404: { description: "Config not found" },
    409: { description: "Config is disabled" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/provider-configs/{id}",
  operationId: "deleteProviderConfig",
  summary: "Delete a provider config",
  tags: ["Provider Configs"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: { description: "No Content" },
    404: { description: "Config not found" },
  },
});

// ─── Payment links ────────────────────────────────────────────────────────────

const createPaymentLinkRequest = createPaymentLinkSchema;

registry.registerPath({
  method: "post",
  path: "/payment-links",
  operationId: "createPaymentLink",
  summary: "Create a payment link",
  tags: ["Payment Links"],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: createPaymentLinkRequest } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: PaymentLinkCreateResponse } },
    },
    400: { description: "Provider not configured" },
  },
});

registry.registerPath({
  method: "get",
  path: "/payment-links",
  operationId: "listPaymentLinks",
  summary: "List payment links",
  tags: ["Payment Links"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: pageOf(PaymentLinkListItem) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/payment-links/{id}",
  operationId: "getPaymentLink",
  summary: "Get a payment link",
  tags: ["Payment Links"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PaymentLinkDetail } },
    },
    404: { description: "Payment link not found" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/payment-links/{id}/cancel",
  operationId: "cancelPaymentLink",
  summary: "Cancel a payment link",
  tags: ["Payment Links"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
    400: { description: "Link not active" },
    404: { description: "Payment link not found" },
  },
});

// ─── Payment intents ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/payment-intents",
  operationId: "createPaymentIntent",
  summary: "Create a direct payment intent",
  tags: ["Payment Intents"],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateIntentRequest } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: CreateIntentResponse } },
    },
    200: {
      description: "Idempotent replay of a recent non-terminal intent",
      content: { "application/json": { schema: CreateIntentResponse } },
    },
    503: { description: "Provider unavailable" },
  },
});

registry.registerPath({
  method: "get",
  path: "/payment-intents/{id}",
  operationId: "getPaymentIntent",
  summary: "Get payment intent detail",
  tags: ["Payment Intents"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PaymentIntentDetail } },
    },
    404: { description: "Payment intent not found" },
  },
});

registry.registerPath({
  method: "get",
  path: "/payment-intents/{id}/status",
  operationId: "getPaymentIntentStatus",
  summary: "Poll latest payment intent status from the provider",
  tags: ["Payment Intents"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: IntentStatusResponse } },
    },
    404: { description: "Payment intent not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/payment-intents/{id}/capture",
  operationId: "capturePaymentIntent",
  summary: "Capture a pre-authorised payment",
  tags: ["Payment Intents"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: IntentActionResult } },
    },
    400: { description: "Missing provider ref / amount" },
    404: { description: "Payment intent not found" },
    409: { description: "Invalid state" },
  },
});

registry.registerPath({
  method: "post",
  path: "/payment-intents/{id}/cancel",
  operationId: "cancelPaymentIntent",
  summary: "Void/cancel a pre-authorised payment",
  tags: ["Payment Intents"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: IntentActionResult } },
    },
    400: { description: "Missing provider ref" },
    404: { description: "Payment intent not found" },
    409: { description: "Invalid state" },
  },
});

// ─── Transactions ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/transactions",
  operationId: "listTransactions",
  summary: "List transactions for the current tenant",
  tags: ["Transactions"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
      status: z.string().optional(),
      provider: z.string().optional(),
      search: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: pageOf(Transaction) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/transactions/{id}",
  operationId: "getTransaction",
  summary: "Get transaction detail",
  tags: ["Transactions"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: TransactionDetail } },
    },
    404: { description: "Transaction not found" },
  },
});

// ─── Refunds ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/transactions/{id}/refund",
  operationId: "refundTransaction",
  summary: "Refund a transaction",
  tags: ["Refunds"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RefundResponse } },
    },
    400: { description: "Not refundable / no provider ref / missing amount" },
    404: { description: "Transaction not found" },
    409: { description: "Already refunded" },
  },
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/dashboard/summary",
  operationId: "getDashboardSummary",
  summary: "Get merchant sales summary",
  tags: ["Dashboard"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DashboardSummary } },
    },
  },
});

// ─── Exports ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/exports/transactions.csv",
  operationId: "exportTransactionsCsv",
  summary: "Export transactions as CSV",
  tags: ["Exports"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.string().optional(),
      provider: z.string().optional(),
      search: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "CSV download",
      content: { "text/csv": { schema: z.string() } },
    },
  },
});

// ─── API keys ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api-keys",
  operationId: "listApiKeys",
  summary: "List API keys",
  tags: ["API Keys"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(ApiKeyListItem) } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api-keys",
  operationId: "createApiKey",
  summary: "Create an API key",
  tags: ["API Keys"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: createApiKeySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ApiKeyCreateResponse } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api-keys/{id}",
  operationId: "deleteApiKey",
  summary: "Revoke an API key",
  tags: ["API Keys"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: { description: "No Content" },
    404: { description: "API key not found" },
  },
});

// ─── Subscriptions ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/subscriptions",
  operationId: "listSubscriptions",
  summary: "List subscriptions",
  tags: ["Subscriptions"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      status: z.string().optional(),
      customerId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: pageOf(SubscriptionListItem) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/subscriptions/{id}",
  operationId: "getSubscription",
  summary: "Get subscription detail",
  tags: ["Subscriptions"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SubscriptionDetail } },
    },
    404: { description: "Subscription not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/subscriptions/{id}/pause",
  operationId: "pauseSubscription",
  summary: "Pause a subscription",
  tags: ["Subscriptions"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
    400: { description: "Invalid state" },
    404: { description: "Subscription not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/subscriptions/{id}/resume",
  operationId: "resumeSubscription",
  summary: "Resume a paused subscription",
  tags: ["Subscriptions"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
    400: { description: "Invalid state" },
    404: { description: "Subscription not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/subscriptions/{id}",
  operationId: "cancelSubscription",
  summary: "Cancel a subscription",
  tags: ["Subscriptions"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
    400: { description: "Already cancelled" },
    404: { description: "Subscription not found" },
  },
});

registry.registerPath({
  method: "get",
  path: "/subscriptions/{id}/events",
  operationId: "listSubscriptionBillingEvents",
  summary: "List billing events for a subscription",
  tags: ["Subscriptions"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: pageOf(BillingEvent) } },
    },
    404: { description: "Subscription not found" },
  },
});

// ─── Installment plans ────────────────────────────────────────────────────────

const planRequest = planSchema;

registry.registerPath({
  method: "get",
  path: "/installment-plans",
  operationId: "listInstallmentPlans",
  summary: "List installment plans",
  tags: ["Installment Plans"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(InstallmentPlanListItem) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/installment-plans",
  operationId: "createInstallmentPlan",
  summary: "Create an installment plan",
  tags: ["Installment Plans"],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: planRequest } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: InstallmentPlan } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/installment-plans/{id}",
  operationId: "updateInstallmentPlan",
  summary: "Update an installment plan",
  tags: ["Installment Plans"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: planRequest.partial() } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: InstallmentPlan } },
    },
    404: { description: "Plan not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/installment-plans/{id}",
  operationId: "deleteInstallmentPlan",
  summary: "Delete an installment plan",
  tags: ["Installment Plans"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ deleted: z.boolean() }) },
      },
    },
    404: { description: "Plan not found" },
    409: { description: "Plan has active agreements" },
  },
});

// ─── Installment agreements ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/installment-agreements",
  operationId: "listInstallmentAgreements",
  summary: "List installment agreements",
  tags: ["Installment Agreements"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      status: z.string().optional(),
      customerId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: pageOf(InstallmentAgreementListItem) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/installment-agreements/{id}",
  operationId: "getInstallmentAgreement",
  summary: "Get installment agreement detail",
  tags: ["Installment Agreements"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: InstallmentAgreementDetail } },
    },
    404: { description: "Agreement not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/installment-agreements/{id}/cancel",
  operationId: "cancelInstallmentAgreement",
  summary: "Cancel an installment agreement",
  tags: ["Installment Agreements"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
    400: { description: "Invalid state" },
    404: { description: "Agreement not found" },
  },
});

// ─── Admin ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/admin/payments/search",
  operationId: "adminSearchPayments",
  summary: "Search payments across identifiers",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({ q: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            found: z.boolean(),
            intent: AdminPaymentSearchIntent.nullable(),
          }),
        },
      },
    },
    400: { description: "Query too short" },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/webhooks",
  operationId: "adminListWebhooks",
  summary: "List webhook events",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      provider: z.string().optional(),
      tenantId: z.string().optional(),
      verified: z.string().optional(),
      processed: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: pageOf(AdminWebhookEvent) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/provider-health",
  operationId: "adminGetProviderHealth",
  summary: "Get provider health status",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.array(ProviderHealthRecord) },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/admin/provider-health/{provider}",
  operationId: "adminSetProviderHealth",
  summary: "Set provider health status",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ provider: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: providerHealthSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ProviderHealthRecord } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/vps-tenants",
  operationId: "adminListVpsTenants",
  summary: "List tenants with a connected VPS config",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(AdminVpsTenant) } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/recurring-test",
  operationId: "adminRecurringTest",
  summary: "Run recurring-billing readiness checks",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ tenantId: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            testedAt: z.string(),
            overallStatus: z.string(),
            totalVpsConfigs: z.number(),
            tenants: z.array(
              z.object({
                tenantId: z.string(),
                tenantName: z.string(),
                checks: z.object({
                  connectivity: z.boolean(),
                  profileStorage: z.boolean(),
                  hasActiveSubscriptions: z.boolean(),
                  migrationApplied: z.boolean(),
                }),
                latencyMs: z.number(),
                vpsError: z.string().optional(),
                dbError: z.string().optional(),
                subscriptionStats: z.object({
                  active: z.number(),
                  pastDue: z.number(),
                  pending: z.number(),
                  cancelledLast30d: z.number(),
                  billingEventsTotal: z.number(),
                }),
                dueTodayCount: z.number(),
              }),
            ),
          }),
        },
      },
    },
  },
});

// ─── Admin tenants ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/admin/tenants",
  operationId: "adminListTenants",
  summary: "List tenants",
  tags: ["Admin Tenants"],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: pageOf(AdminTenantListItem) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/tenants/{id}",
  operationId: "adminGetTenant",
  summary: "Get tenant detail",
  tags: ["Admin Tenants"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AdminTenantDetail } },
    },
    404: { description: "Tenant not found" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/admin/tenants/{id}/status",
  operationId: "adminSetTenantStatus",
  summary: "Enable or disable a tenant",
  tags: ["Admin Tenants"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: tenantStatusSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
  },
});

// ─── Admin provider configs ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/admin/tenants/{id}/provider-configs",
  operationId: "adminGetTenantProviderConfigs",
  summary: "List a tenant's provider configs (credentials masked)",
  tags: ["Admin Provider Configs"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.array(
            z.object({
              id: z.string(),
              provider: z.string(),
              status: z.string(),
              environment: z.string(),
              credentials: Json,
            }),
          ),
        },
      },
    },
  },
});

// ─── Admin simulation ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/admin/simulation/start",
  operationId: "simulationStart",
  summary: "Spin up a recurring-billing simulation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: startSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string(),
            subscriptionId: z.string(),
            paymentIntentId: z.string(),
            retries: z.object({
              delay1: z.string(),
              delay2: z.string(),
              delay3: z.string(),
            }),
          }),
        },
      },
    },
    400: { description: "No VPS config" },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/simulation/status/{sessionId}",
  operationId: "simulationStatus",
  summary: "Poll simulation subscription state",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string(),
            subscription: SubscriptionDetail,
            billingEvents: z.array(BillingEvent),
            done: z.boolean(),
          }),
        },
      },
    },
    404: { description: "Simulation session not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/admin/simulation/cleanup/{sessionId}",
  operationId: "simulationCleanup",
  summary: "Wipe records created by a simulation session",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.object({
              subscriptions: z.number(),
              billingEvents: z.number(),
              paymentIntents: z.number(),
            }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/simulation/bnpl/plans/{tenantId}",
  operationId: "simulationBnplPlans",
  summary: "List a tenant's active installment plans",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ tenantId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                durationMonths: z.number(),
                annualInterestRate: z.number(),
                minAmount: z.number().nullable(),
                maxAmount: z.number().nullable(),
              }),
            ),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/simulation/bnpl/prepare",
  operationId: "simulationBnplPrepare",
  summary: "Create a throwaway installment link + PayWall payload",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: bnplPrepareSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": {
          schema: z.object({
            linkId: z.string(),
            agreementId: z.string(),
            sessionTag: z.string(),
            paywallUrl: z.string(),
            paywallPayload: z.string(),
            paywallSignature: z.string(),
            preview: z.object({
              totalInstallments: z.number(),
              installmentAmount: z.number(),
              principalAmount: z.number(),
              apr: z.number(),
              currency: z.string(),
            }),
          }),
        },
      },
    },
    400: { description: "No VPS config" },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/simulation/bnpl/await-agreement/{linkId}",
  operationId: "simulationBnplAwaitAgreement",
  summary: "Poll for agreement activation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ linkId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            found: z.boolean(),
            agreementId: z.string().optional(),
            status: z.string().optional(),
            totalInstallments: z.number().optional(),
            paidCount: z.number().optional(),
            installmentAmount: z.number().optional(),
            currency: z.string().optional(),
            paymentServiceUrl: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/simulation/bnpl/fire",
  operationId: "simulationBnplFire",
  summary: "Launch an accelerated installment simulation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: bnplFireSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            agreementId: z.string(),
            delays: z.object({
              chargeDelay: z.string(),
              retryDelay1: z.string(),
              retryDelay2: z.string(),
              retryDelay3: z.string(),
            }),
          }),
        },
      },
    },
    400: { description: "Not a sim agreement / not active" },
    404: { description: "Agreement not found" },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/simulation/bnpl/status/{agreementId}",
  operationId: "simulationBnplStatus",
  summary: "Poll installment agreement + charges",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ agreementId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            agreementId: z.string(),
            agreement: InstallmentAgreementDetail,
            installmentCharges: z.array(InstallmentCharge),
            done: z.boolean(),
          }),
        },
      },
    },
    404: { description: "Agreement not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/admin/simulation/bnpl/cleanup/{agreementId}",
  operationId: "simulationBnplCleanup",
  summary: "Teardown BNPL sandbox fixtures",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ agreementId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.object({
              charges: z.number(),
              agreements: z.number(),
              paymentIntents: z.number(),
              paymentLinks: z.number(),
              plans: z.number(),
            }),
          }),
        },
      },
    },
  },
});

const simulationPrepareRequest = prepareSchema;

const simulationPrepareResponse = z.object({
  intentId: z.string(),
  linkId: z.string(),
  sessionTag: z.string(),
  paywallUrl: z.string(),
  paywallPayload: z.string(),
  paywallSignature: z.string(),
  amount: z.number(),
});

registry.registerPath({
  method: "post",
  path: "/admin/simulation/direct/prepare",
  operationId: "simulationDirectPrepare",
  summary: "Create a direct-charge simulation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: simulationPrepareRequest } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: simulationPrepareResponse } },
    },
    400: { description: "No VPS config" },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/simulation/direct/status/{intentId}",
  operationId: "simulationDirectStatus",
  summary: "Poll direct-charge simulation status",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ intentId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            intentId: z.string(),
            status: z.string(),
            providerRef: z.string().nullable(),
            terminal: z.boolean(),
            rawVpsStatus: z.string().nullable().optional(),
            paymentServiceUrl: z.string().nullable().optional(),
            settleError: z.string().optional(),
            vpsRawResponse: Json.optional(),
            queryError: z.string().optional(),
          }),
        },
      },
    },
    404: { description: "Intent not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/admin/simulation/direct/cleanup/{intentId}",
  operationId: "simulationDirectCleanup",
  summary: "Teardown a direct-charge simulation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ intentId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.object({ intents: z.number(), links: z.number() }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/simulation/preauth/prepare",
  operationId: "simulationPreauthPrepare",
  summary: "Create a pre-auth simulation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: simulationPrepareRequest } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: simulationPrepareResponse } },
    },
    400: { description: "No VPS config" },
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/simulation/preauth/status/{intentId}",
  operationId: "simulationPreauthStatus",
  summary: "Poll pre-auth simulation status",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ intentId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            intentId: z.string(),
            status: z.string(),
            providerRef: z.string().nullable(),
            terminal: z.boolean(),
            authorized: z.boolean(),
            rawVpsStatus: z.string().nullable().optional(),
            paymentServiceUrl: z.string().nullable().optional(),
            queryError: z.string().optional(),
          }),
        },
      },
    },
    404: { description: "Intent not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/simulation/preauth/capture/{intentId}",
  operationId: "simulationPreauthCapture",
  summary: "Settle a pre-authorized charge",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ intentId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: IntentActionResult } },
    },
    400: { description: "Wrong state / no provider ref" },
    404: { description: "Intent not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/simulation/preauth/cancel/{intentId}",
  operationId: "simulationPreauthCancel",
  summary: "Release held funds (auth reversal)",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ intentId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: IntentActionResult } },
    },
    400: { description: "Wrong state / no provider ref" },
    404: { description: "Intent not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/admin/simulation/preauth/cleanup/{intentId}",
  operationId: "simulationPreauthCleanup",
  summary: "Teardown a pre-auth simulation",
  tags: ["Admin Simulation"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ intentId: z.string() }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.object({ intents: z.number(), links: z.number() }),
          }),
        },
      },
    },
  },
});

// ─── Ledger ───────────────────────────────────────────────────────────────────

const LedgerEntry = registry.register(
  "LedgerEntry",
  z.object({
    id: z.string(),
    postingId: z.string(),
    account: z.string(),
    direction: z.string(),
    category: z.string(),
    amount: Money,
    balanceAfter: Money,
    sourceType: z.string().nullable(),
    sourceId: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const LedgerResponse = registry.register(
  "LedgerResponse",
  z.object({
    balanced: z.boolean(),
    balances: z.record(z.string(), Money),
    entries: z.array(LedgerEntry),
  }),
);

registry.registerPath({
  method: "get",
  path: "/ledger",
  operationId: "getLedger",
  summary: "Get the current tenant's settlement ledger (balances + entries)",
  tags: ["Ledger"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: LedgerResponse } },
    },
  },
});

// ─── Fee schedules ─────────────────────────────────────────────────────────────

const FeeSchedule = registry.register(
  "FeeSchedule",
  z.object({
    id: z.string(),
    version: z.number(),
    name: z.string().nullable(),
    feeType: z.string(),
    flatCents: z.number().int().nullable(),
    percentageBps: z.number().int().nullable(),
    perMethodCents: z.record(z.string(), z.number()).nullable(),
    tiersCents: z.array(z.object({ upToCents: z.number(), percentageBps: z.number() })).nullable(),
    currency: z.string(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/fee-schedules",
  operationId: "listFeeSchedules",
  summary: "List fee schedules",
  tags: ["Fee Schedules"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.array(FeeSchedule) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/fee-schedules",
  operationId: "createFeeSchedule",
  summary: "Create a fee schedule",
  tags: ["Fee Schedules"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createFeeScheduleSchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: FeeSchedule } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/fee-schedules/active",
  operationId: "getActiveFeeSchedule",
  summary: "Get the active fee schedule",
  tags: ["Fee Schedules"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: FeeSchedule } } },
    404: { description: "No active fee schedule" },
  },
});

// ─── Settlement policies ────────────────────────────────────────────────────────

const SettlementPolicy = registry.register(
  "SettlementPolicy",
  z.object({
    id: z.string(),
    version: z.number(),
    name: z.string().nullable(),
    industry: z.string().nullable(),
    mcc: z.string().nullable(),
    availabilityMode: z.string(),
    availabilityDelayDays: z.number().int().nullable(),
    reserveType: z.string(),
    reservePercentageBps: z.number().int().nullable(),
    reserveHoldDays: z.number().int().nullable(),
    reserveFixedCents: z.number().int().nullable(),
    payoutSchedule: z.string(),
    payoutMinCents: z.number().int().nullable(),
    reversalFunding: z.string(),
    allowNegative: z.boolean(),
    splittingEnabled: z.boolean(),
    feeScheduleId: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/settlement-policies",
  operationId: "listSettlementPolicies",
  summary: "List settlement policies",
  tags: ["Settlement Policies"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(SettlementPolicy) } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/settlement-policies",
  operationId: "createSettlementPolicy",
  summary: "Create a settlement policy",
  tags: ["Settlement Policies"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createSettlementPolicySchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: SettlementPolicy } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/settlement-policies/active",
  operationId: "getActiveSettlementPolicy",
  summary: "Get the active settlement policy",
  tags: ["Settlement Policies"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SettlementPolicy } } },
    404: { description: "No active settlement policy" },
  },
});

// ─── Payouts ────────────────────────────────────────────────────────────────────

const PayoutItem = registry.register(
  "PayoutItem",
  z.object({
    id: z.string(),
    ledgerEntryId: z.string(),
    amountCents: z.number().int(),
  }),
);

const Payout = registry.register(
  "Payout",
  z.object({
    id: z.string(),
    status: z.string(),
    provider: z.string(),
    method: z.string(),
    currency: z.string(),
    amountCents: z.number().int(),
    feeCents: z.number().int(),
    providerTransferId: z.string().nullable(),
    idempotencyKey: z.string(),
    items: z.array(PayoutItem),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/payouts",
  operationId: "listPayouts",
  summary: "List payouts",
  tags: ["Payouts"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.array(Payout) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/payouts",
  operationId: "createPayout",
  summary: "Snapshot eligible funds into a payout",
  tags: ["Payouts"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createPayoutSchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Payout } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/payouts/{id}",
  operationId: "getPayout",
  summary: "Get a payout",
  tags: ["Payouts"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Payout } } },
    404: { description: "Payout not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/payouts/{id}/cancel",
  operationId: "cancelPayout",
  summary: "Cancel a payout",
  tags: ["Payouts"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Payout } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/payouts/{id}/process",
  operationId: "processPayout",
  summary: "Disburse a payout via the provider and settle the ledger",
  tags: ["Payouts"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Payout } } },
    404: { description: "Payout not found" },
  },
});

// ─── Disputes / chargebacks ────────────────────────────────────────────────────

const Recovery = registry.register(
  "Recovery",
  z.object({
    id: z.string(),
    status: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    createdAt: z.string(),
  }),
);

const Dispute = registry.register(
  "Dispute",
  z.object({
    id: z.string(),
    status: z.string(),
    provider: z.string(),
    providerDisputeId: z.string(),
    paymentIntentId: z.string().nullable(),
    amountCents: z.number().int(),
    feeCents: z.number().int(),
    currency: z.string(),
    reason: z.string().nullable(),
    evidenceDueDate: z.string().nullable(),
    recovery: Recovery.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/disputes",
  operationId: "listDisputes",
  summary: "List disputes",
  tags: ["Disputes"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.array(Dispute) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/disputes",
  operationId: "createDispute",
  summary: "Record an inbound chargeback/dispute",
  tags: ["Disputes"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createDisputeSchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Dispute } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/disputes/{id}",
  operationId: "getDispute",
  summary: "Get a dispute",
  tags: ["Disputes"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Dispute } } },
    404: { description: "Dispute not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/disputes/{id}/resolve",
  operationId: "resolveDispute",
  summary: "Resolve a dispute (won/lost)",
  tags: ["Disputes"],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: resolveDisputeSchema } },
    },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Dispute } } },
    404: { description: "Dispute not found" },
  },
});

// ─── Splits (multi-party division) ─────────────────────────────────────────────

const SplitParty = registry.register(
  "SplitParty",
  z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    type: z.string(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const SplitRule = registry.register(
  "SplitRule",
  z.object({
    id: z.string(),
    name: z.string(),
    trigger: z.string(),
    shares: Json,
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const Split = registry.register(
  "Split",
  z.object({
    id: z.string(),
    splitRuleId: z.string().nullable(),
    sourceType: z.string(),
    sourceId: z.string(),
    partyId: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    status: z.string(),
    heldUntil: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/split-parties",
  operationId: "listSplitParties",
  summary: "List split parties (beneficiaries)",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.array(SplitParty) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/split-parties",
  operationId: "createSplitParty",
  summary: "Create a split party",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createSplitPartySchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: SplitParty } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/split-parties/{id}",
  operationId: "getSplitParty",
  summary: "Get a split party",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SplitParty } } },
    404: { description: "Split party not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/split-parties/{id}/deactivate",
  operationId: "deactivateSplitParty",
  summary: "Deactivate a split party",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SplitParty } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/split-rules",
  operationId: "listSplitRules",
  summary: "List split rules",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.array(SplitRule) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/split-rules",
  operationId: "createSplitRule",
  summary: "Create a split rule",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createSplitRuleSchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: SplitRule } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/split-rules/{id}",
  operationId: "getSplitRule",
  summary: "Get a split rule",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SplitRule } } },
    404: { description: "Split rule not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/split-rules/{id}/deactivate",
  operationId: "deactivateSplitRule",
  summary: "Deactivate a split rule",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SplitRule } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/splits",
  operationId: "listSplits",
  summary: "List split executions",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.array(Split) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/splits",
  operationId: "executeSplit",
  summary: "Divide a source amount among beneficiary parties",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: executeSplitSchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.array(Split) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/splits/{id}",
  operationId: "getSplit",
  summary: "Get a split",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Split } } },
    404: { description: "Split not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/splits/{id}/release",
  operationId: "releaseSplit",
  summary: "Release a held split (RESERVE → AVAILABLE)",
  tags: ["Splits"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Split } } },
    404: { description: "Split not found" },
  },
});

// ─── Reconciliation (three-way match) ────────────────────────────────────────

const ReconciliationLine = registry.register(
  "ReconciliationLine",
  z.object({
    id: z.string(),
    reference: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    status: z.string(),
    matchedAmountCents: z.number().int().nullable(),
    differenceAmountCents: z.number().int().nullable(),
    createdAt: z.string(),
  }),
);

const ReconciliationSummary = registry.register(
  "ReconciliationSummary",
  z.object({
    exactCount: z.number().int(),
    amountDiffCount: z.number().int(),
    missingInternal: z.array(z.object({ reference: z.string(), amountCents: z.number().int() })),
    missingExternal: z.array(z.object({ reference: z.string(), amountCents: z.number().int() })),
    externalTotalCents: z.number().int(),
    internalTotalCents: z.number().int(),
    netDifferenceCents: z.number().int(),
  }),
);

const ReconciliationReport = registry.register(
  "ReconciliationReport",
  z.object({
    id: z.string(),
    provider: z.string(),
    currency: z.string(),
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    status: z.string(),
    summary: ReconciliationSummary.nullable(),
    lines: z.array(ReconciliationLine),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/reconciliation-reports",
  operationId: "listReconciliationReports",
  summary: "List reconciliation reports",
  tags: ["Reconciliation"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(ReconciliationReport) } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/reconciliation-reports",
  operationId: "createReconciliationReport",
  summary: "Ingest a provider statement for reconciliation",
  tags: ["Reconciliation"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: createReconciliationReportSchema } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ReconciliationReport } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/reconciliation-reports/{id}",
  operationId: "getReconciliationReport",
  summary: "Get a reconciliation report",
  tags: ["Reconciliation"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ReconciliationReport } } },
    404: { description: "Reconciliation report not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/reconciliation-reports/{id}/run",
  operationId: "runReconciliation",
  summary: "Run the three-way match against the tenant ledger",
  tags: ["Reconciliation"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ReconciliationReport } } },
    404: { description: "Reconciliation report not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/reconciliation-reports/{id}/resolve",
  operationId: "resolveReconciliation",
  summary: "Close a reconciliation report after review",
  tags: ["Reconciliation"],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ReconciliationReport } } },
    404: { description: "Reconciliation report not found" },
  },
});
