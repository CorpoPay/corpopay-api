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

export type PaymentIntentStatus =
  | "CREATED"
  | "REQUIRES_ACTION"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "REFUNDED";
export const PaymentIntentStatusValues = [
  "CREATED",
  "REQUIRES_ACTION",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "REFUNDED",
] as const;

export type RefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";
export const RefundStatusValues = ["PENDING", "SUCCEEDED", "FAILED"] as const;

export type ProviderHealthStatus = "NORMAL" | "DEGRADED" | "DOWN";
export const ProviderHealthStatusValues = ["NORMAL", "DEGRADED", "DOWN"] as const;

export type AuditAction =
  | "PROVIDER_CONFIG_CREATED"
  | "PROVIDER_CONFIG_UPDATED"
  | "PROVIDER_CONFIG_DELETED"
  | "PROVIDER_CONFIG_VALIDATED"
  | "PROVIDER_CONFIG_DISABLED"
  | "PROVIDER_CONFIG_ENABLED"
  | "REFUND_INITIATED"
  | "REFUND_SUCCEEDED"
  | "REFUND_FAILED"
  | "API_KEY_CREATED"
  | "API_KEY_REVOKED"
  | "TENANT_DISABLED"
  | "TENANT_ENABLED"
  | "USER_INVITED"
  | "USER_ROLE_CHANGED"
  | "USER_REMOVED"
  | "PAYMENT_LINK_CANCELED"
  | "SUBSCRIPTION_CREATED"
  | "SUBSCRIPTION_PAUSED"
  | "SUBSCRIPTION_RESUMED"
  | "SUBSCRIPTION_CANCELED"
  | "INSTALLMENT_PLAN_CREATED"
  | "INSTALLMENT_PLAN_UPDATED"
  | "INSTALLMENT_PLAN_DELETED"
  | "INSTALLMENT_AGREEMENT_CANCELLED";
export const AuditActionValues = [
  "PROVIDER_CONFIG_CREATED",
  "PROVIDER_CONFIG_UPDATED",
  "PROVIDER_CONFIG_DELETED",
  "PROVIDER_CONFIG_VALIDATED",
  "PROVIDER_CONFIG_DISABLED",
  "PROVIDER_CONFIG_ENABLED",
  "REFUND_INITIATED",
  "REFUND_SUCCEEDED",
  "REFUND_FAILED",
  "API_KEY_CREATED",
  "API_KEY_REVOKED",
  "TENANT_DISABLED",
  "TENANT_ENABLED",
  "USER_INVITED",
  "USER_ROLE_CHANGED",
  "USER_REMOVED",
  "PAYMENT_LINK_CANCELED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_PAUSED",
  "SUBSCRIPTION_RESUMED",
  "SUBSCRIPTION_CANCELED",
  "INSTALLMENT_PLAN_CREATED",
  "INSTALLMENT_PLAN_UPDATED",
  "INSTALLMENT_PLAN_DELETED",
  "INSTALLMENT_AGREEMENT_CANCELLED",
] as const;

export type InstallmentAgreementStatus =
  | "PENDING_CHECKOUT"
  | "ACTIVE"
  | "COMPLETED"
  | "DEFAULTED"
  | "CANCELLED";
export const InstallmentAgreementStatusValues = [
  "PENDING_CHECKOUT",
  "ACTIVE",
  "COMPLETED",
  "DEFAULTED",
  "CANCELLED",
] as const;

export type SubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "PAUSED"
  | "CANCELLED"
  | "PAST_DUE"
  | "EXPIRED";
export const SubscriptionStatusValues = [
  "PENDING",
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "PAST_DUE",
  "EXPIRED",
] as const;

export type BillingInterval = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL" | "CUSTOM";
export const BillingIntervalValues = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
  "CUSTOM",
] as const;

export type LedgerAccount =
  | "CASH"
  | "PENDING"
  | "COLLECTED"
  | "AVAILABLE"
  | "RESERVE"
  | "FEES"
  | "PAID_OUT";
export const LedgerAccountValues = [
  "CASH",
  "PENDING",
  "COLLECTED",
  "AVAILABLE",
  "RESERVE",
  "FEES",
  "PAID_OUT",
] as const;

export type LedgerDirection = "DEBIT" | "CREDIT";
export const LedgerDirectionValues = ["DEBIT", "CREDIT"] as const;

export type LedgerCategory =
  | "CAPTURE"
  | "REFUND"
  | "FEE"
  | "SPLIT"
  | "PAYOUT"
  | "CHARGEBACK"
  | "RESERVE_RELEASE"
  | "ADJUSTMENT"
  | "DISBURSEMENT";
export const LedgerCategoryValues = [
  "CAPTURE",
  "REFUND",
  "FEE",
  "SPLIT",
  "PAYOUT",
  "CHARGEBACK",
  "RESERVE_RELEASE",
  "ADJUSTMENT",
  "DISBURSEMENT",
] as const;

export type FeeType = "FLAT" | "PERCENTAGE" | "PER_METHOD" | "TIERED";
export const FeeTypeValues = ["FLAT", "PERCENTAGE", "PER_METHOD", "TIERED"] as const;

export type AvailabilityMode = "IMMEDIATE" | "DELAY" | "ON_FULFILLMENT" | "ON_COLLECTION";
export const AvailabilityModeValues = [
  "IMMEDIATE",
  "DELAY",
  "ON_FULFILLMENT",
  "ON_COLLECTION",
] as const;

export type PayoutSchedule =
  | "MANUAL"
  | "AUTO_DAILY"
  | "AUTO_WEEKLY"
  | "AUTO_MONTHLY"
  | "THRESHOLD"
  | "INSTANT";
export const PayoutScheduleValues = [
  "MANUAL",
  "AUTO_DAILY",
  "AUTO_WEEKLY",
  "AUTO_MONTHLY",
  "THRESHOLD",
  "INSTANT",
] as const;

export type ReserveType = "NONE" | "FIXED" | "ROLLING";
export const ReserveTypeValues = ["NONE", "FIXED", "ROLLING"] as const;

export type ReversalFundingPolicy =
  | "NET_FROM_AVAILABLE"
  | "DEBIT_RESERVE"
  | "INVOICE_TENANT"
  | "ALLOW_NEGATIVE";
export const ReversalFundingPolicyValues = [
  "NET_FROM_AVAILABLE",
  "DEBIT_RESERVE",
  "INVOICE_TENANT",
  "ALLOW_NEGATIVE",
] as const;

export type PayoutStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "PENDING"
  | "PROCESSING"
  | "PAID"
  | "FAILED"
  | "CANCELLED";
export const PayoutStatusValues = [
  "DRAFT",
  "SCHEDULED",
  "PENDING",
  "PROCESSING",
  "PAID",
  "FAILED",
  "CANCELLED",
] as const;

export type PayoutMethod = "BANK_TRANSFER" | "CARD" | "WALLET";
export const PayoutMethodValues = ["BANK_TRANSFER", "CARD", "WALLET"] as const;

export type DisputeStatus = "OPEN" | "WON" | "LOST";
export const DisputeStatusValues = ["OPEN", "WON", "LOST"] as const;

export type RecoveryStatus = "PENDING" | "COLLECTED" | "WAIVED";
export const RecoveryStatusValues = ["PENDING", "COLLECTED", "WAIVED"] as const;

export type SplitTrigger = "AT_CAPTURE" | "ON_USAGE" | "MANUAL";
export const SplitTriggerValues = ["AT_CAPTURE", "ON_USAGE", "MANUAL"] as const;

export type SplitPartyType = "PLATFORM" | "SUB_MERCHANT" | "VENDOR" | "AFFILIATE" | "ESCROW";
export const SplitPartyTypeValues = [
  "PLATFORM",
  "SUB_MERCHANT",
  "VENDOR",
  "AFFILIATE",
  "ESCROW",
] as const;

export type SplitStatus = "PENDING" | "SETTLED" | "REVERSED";
export const SplitStatusValues = ["PENDING", "SETTLED", "REVERSED"] as const;

export type ReconciliationStatus = "PENDING" | "MATCHED" | "UNMATCHED" | "RESOLVED";
export const ReconciliationStatusValues = ["PENDING", "MATCHED", "UNMATCHED", "RESOLVED"] as const;

export type ReconciliationMatchStatus = "UNMATCHED" | "EXACT" | "AMOUNT_DIFF";
export const ReconciliationMatchStatusValues = ["UNMATCHED", "EXACT", "AMOUNT_DIFF"] as const;

export type SettlementStatementStatus = "DRAFT" | "FINALIZED" | "VOID";
export const SettlementStatementStatusValues = ["DRAFT", "FINALIZED", "VOID"] as const;

export type OnboardingStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "NEEDS_INFO";
export const OnboardingStatusValues = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "NEEDS_INFO",
] as const;

export type RiskTier = "LOW" | "MEDIUM" | "HIGH";
export const RiskTierValues = ["LOW", "MEDIUM", "HIGH"] as const;
