/**
 * mock-prisma.ts — build a fully-mocked Prisma client for integration tests.
 *
 * The real routes import `prisma` from `@/lib/prisma` and `forTenant` from
 * `@/lib/tenant-db`. `forTenant` wraps `prisma.$extends`, so this mock gives
 * `$extends` a self-returning implementation — the REAL `forTenant` then returns
 * this same mock, meaning a single object backs both tenant-scoped (`db.x`) and
 * cross-tenant (`prisma.x`) queries. Each model method is a fresh `vi.fn()` that
 * a test can stub with `mockResolvedValue`, `mockRejectedValue`, etc.
 *
 * `$transaction` supports both call forms used across the codebase:
 *   - an array of promises  → `Promise.all`
 *   - a callback `(tx) => …` → invoked with this mock as `tx`
 */

import { vi } from "vitest";

function makeModel() {
  return {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    upsert: vi.fn(),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a dynamic mock client is intentionally loose.
export type MockPrisma = Record<string, any>;

export function buildMockPrisma(): MockPrisma {
  const prisma: MockPrisma = {
    tenant: makeModel(),
    user: makeModel(),
    providerConfig: makeModel(),
    paymentLink: makeModel(),
    paymentIntent: makeModel(),
    providerTransaction: makeModel(),
    refund: makeModel(),
    webhookEvent: makeModel(),
    apiKey: makeModel(),
    auditLog: makeModel(),
    subscription: makeModel(),
    billingEvent: makeModel(),
    installmentPlan: makeModel(),
    installmentAgreement: makeModel(),
    installmentCharge: makeModel(),
    ledgerEntry: makeModel(),
    feeSchedule: makeModel(),
    settlementPolicy: makeModel(),
    payout: makeModel(),
    payoutItem: makeModel(),
    dispute: makeModel(),
    recovery: makeModel(),
    providerHealth: makeModel(),
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === "function") return arg(prisma);
      return arg;
    }),
    $disconnect: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
  };
  prisma.$extends = vi.fn(() => prisma);
  return prisma;
}
