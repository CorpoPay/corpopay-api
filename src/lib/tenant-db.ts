import { prisma } from "./prisma";

/**
 * Multi-tenant data isolation.
 *
 * Every tenant-owned row carries a non-null `tenantId`. Historically that
 * invariant was enforced by *convention*: each route remembered to add
 * `tenantId` to every query. A forgotten filter is a cross-tenant data leak,
 * so we make it impossible to forget by routing all tenant-scoped access
 * through `forTenant(tenantId)` — a Prisma client that injects `tenantId` into
 * the `where` of every tenant-scoped query automatically.
 *
 * Cross-tenant / admin / webhook / background-job code keeps using the raw
 * `prisma` client (those code paths legitimately span tenants, e.g. an admin
 * listing all tenants, or a webhook that must look up a payment intent by its
 * provider `correlationId` before the tenant is known).
 */

/**
 * Models that own a tenant (non-null `tenantId` column). `WebhookEvent` and
 * `AuditLog` are intentionally excluded — their `tenantId` is nullable and they
 * are routinely read cross-tenant (by webhook dedup and admin audit views).
 */
export const TENANT_SCOPED_MODELS = [
  "User",
  "ProviderConfig",
  "PaymentLink",
  "PaymentIntent",
  "Refund",
  "ApiKey",
  "Subscription",
  "InstallmentPlan",
  "InstallmentAgreement",
  "LedgerEntry",
  "FeeSchedule",
  "SettlementPolicy",
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const TENANT_SCOPED_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);

/**
 * Operations whose `where` is a non-unique *filter* (safe to merge `tenantId`
 * into). Unique-selector operations (`findUnique`, `findUniqueOrThrow`,
 * `update`, `delete`, `upsert`) require a single unique `where` and are
 * deliberately left out — for tenant-bound access to a single record use
 * `findFirst` / `updateMany` / `deleteMany` instead.
 */
const FILTER_OPERATIONS: ReadonlySet<string> = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

export function isTenantScopedModel(model: string): model is TenantScopedModel {
  return TENANT_SCOPED_SET.has(model);
}

/**
 * Pure helper: returns `args` with `tenantId` merged into `where` when the
 * operation targets a tenant-scoped model and accepts a filter `where`.
 *
 * Kept pure (no Prisma) so the scoping rule is trivially unit-testable;
 * `forTenant` below wraps it in a Prisma client extension.
 */
export function withTenantFilter(
  tenantId: string,
  model: string,
  operation: string,
  args: unknown,
): unknown {
  if (!isTenantScopedModel(model)) return args;
  if (!FILTER_OPERATIONS.has(operation)) return args;

  const current = (args ?? {}) as { where?: unknown };
  return {
    ...current,
    where: { ...((current.where as Record<string, unknown>) ?? {}), tenantId },
  };
}

/**
 * Returns a Prisma client whose tenant-scoped models automatically scope every
 * list/first/count/aggregate/groupBy/updateMany/deleteMany by `tenantId`.
 *
 * Unique-selector operations (`findUnique`, `update`, `delete`, `upsert`) are
 * intentionally NOT auto-scoped; prefer `findFirst` / `updateMany` /
 * `deleteMany` when a tenant boundary must be enforced.
 *
 * @example
 *   const db = forTenant(req.user.tenantId);
 *   const links = await db.paymentLink.findMany({ where: { status: "ACTIVE" } });
 *   // → WHERE ("tenantId" = ? AND "status" = 'ACTIVE')
 */
export function forTenant(tenantId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // The `$allOperations` hook sees a heterogeneous union of args across
          // every model + operation, so we cross the type boundary here and let
          // `withTenantFilter` (pure, unit-tested) decide what to scope.
          const scoped = withTenantFilter(tenantId, model as string, operation, args as any);
          return query(scoped as typeof args);
        },
      },
    },
  });
}
