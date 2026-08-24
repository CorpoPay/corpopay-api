// Generated from prisma/schema.prisma — do not edit by hand.
// Source of truth: corpopay-api/prisma/schema.prisma enums.
// Regenerate with: npm run contract:generate

export type TenantStatus = "ACTIVE" | "DISABLED";
export const TenantStatusValues = ["ACTIVE", "DISABLED"] as const;

export type Environment = "SANDBOX" | "PRODUCTION";
export const EnvironmentValues = ["SANDBOX", "PRODUCTION"] as const;

export type UserRole = "OWNER" | "STAFF" | "SUPPORT_ADMIN" | "SUPER_ADMIN";
export const UserRoleValues = ["OWNER", "STAFF", "SUPPORT_ADMIN", "SUPER_ADMIN"] as const;

export type Provider = "NAPS" | "VPS" | "STRIPE" | "PAYPAL" | "ADYEN";
export const ProviderValues = ["NAPS", "VPS", "STRIPE", "PAYPAL", "ADYEN"] as const;

export type ProviderConfigStatus = "CONNECTED" | "INVALID" | "MISSING" | "DISABLED";
export const ProviderConfigStatusValues = ["CONNECTED", "INVALID", "MISSING", "DISABLED"] as const;

export type PaymentLinkStatus = "ACTIVE" | "PAID" | "EXPIRED" | "CANCELED";
export const PaymentLinkStatusValues = ["ACTIVE", "PAID", "EXPIRED", "CANCELED"] as const;

export type PaymentIntentStatus = "CREATED" | "REQUIRES_ACTION" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "REFUNDED";
export const PaymentIntentStatusValues = ["CREATED", "REQUIRES_ACTION", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"] as const;

export type RefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";
export const RefundStatusValues = ["PENDING", "SUCCEEDED", "FAILED"] as const;

export type ProviderHealthStatus = "NORMAL" | "DEGRADED" | "DOWN";
export const ProviderHealthStatusValues = ["NORMAL", "DEGRADED", "DOWN"] as const;

export type AuditAction = "PROVIDER_CONFIG_CREATED" | "PROVIDER_CONFIG_UPDATED" | "PROVIDER_CONFIG_DELETED" | "PROVIDER_CONFIG_VALIDATED" | "PROVIDER_CONFIG_DISABLED" | "PROVIDER_CONFIG_ENABLED" | "REFUND_INITIATED" | "REFUND_SUCCEEDED" | "REFUND_FAILED" | "API_KEY_CREATED" | "API_KEY_REVOKED" | "TENANT_DISABLED" | "TENANT_ENABLED" | "USER_INVITED" | "USER_ROLE_CHANGED" | "USER_REMOVED" | "PAYMENT_LINK_CANCELED" | "SUBSCRIPTION_CREATED" | "SUBSCRIPTION_PAUSED" | "SUBSCRIPTION_RESUMED" | "SUBSCRIPTION_CANCELED" | "INSTALLMENT_PLAN_CREATED" | "INSTALLMENT_PLAN_UPDATED" | "INSTALLMENT_PLAN_DELETED" | "INSTALLMENT_AGREEMENT_CANCELLED";
export const AuditActionValues = ["PROVIDER_CONFIG_CREATED", "PROVIDER_CONFIG_UPDATED", "PROVIDER_CONFIG_DELETED", "PROVIDER_CONFIG_VALIDATED", "PROVIDER_CONFIG_DISABLED", "PROVIDER_CONFIG_ENABLED", "REFUND_INITIATED", "REFUND_SUCCEEDED", "REFUND_FAILED", "API_KEY_CREATED", "API_KEY_REVOKED", "TENANT_DISABLED", "TENANT_ENABLED", "USER_INVITED", "USER_ROLE_CHANGED", "USER_REMOVED", "PAYMENT_LINK_CANCELED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_PAUSED", "SUBSCRIPTION_RESUMED", "SUBSCRIPTION_CANCELED", "INSTALLMENT_PLAN_CREATED", "INSTALLMENT_PLAN_UPDATED", "INSTALLMENT_PLAN_DELETED", "INSTALLMENT_AGREEMENT_CANCELLED"] as const;

export type InstallmentAgreementStatus = "PENDING_CHECKOUT" | "ACTIVE" | "COMPLETED" | "DEFAULTED" | "CANCELLED";
export const InstallmentAgreementStatusValues = ["PENDING_CHECKOUT", "ACTIVE", "COMPLETED", "DEFAULTED", "CANCELLED"] as const;

export type SubscriptionStatus = "PENDING" | "ACTIVE" | "PAUSED" | "CANCELLED" | "PAST_DUE" | "EXPIRED";
export const SubscriptionStatusValues = ["PENDING", "ACTIVE", "PAUSED", "CANCELLED", "PAST_DUE", "EXPIRED"] as const;

export type BillingInterval = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL" | "CUSTOM";
export const BillingIntervalValues = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"] as const;
