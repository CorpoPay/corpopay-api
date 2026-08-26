import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { centimes, centimesToMad, centimesToMadString, madToCentimes } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { forTenant } from "@/lib/tenant-db";
import {
  makePaymentIntent,
  makePaymentLink,
  makeTenant,
  makeUser,
  makeWebhookEvent,
} from "../factories";

/**
 * Real-Postgres smoke suite. Complements the mocked integration/E2E suites by
 * asserting the invariants a mock cannot: Decimal(12,2) money round-trips,
 * tenant scoping through a real query engine, and database-enforced unique
 * constraints (idempotency) + FK cascades.
 *
 * Run via `npm run test:db` with a reachable DATABASE_URL. CI provisions a
 * Postgres service, runs `prisma migrate deploy`, then this suite.
 */

const A = "db-smoke-a";
const B = "db-smoke-b";

describe("real database smoke", () => {
  beforeAll(async () => {
    // Fail fast with a clear message when no reachable Postgres is configured.
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `DB smoke tests need a reachable Postgres via DATABASE_URL. Original error: ${String(err)}`,
      );
    }

    // Idempotent reset so re-runs never collide with leftover fixtures.
    await prisma.webhookEvent.deleteMany({ where: { id: { in: [`${A}-webhook`] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });

    await prisma.tenant.create({ data: makeTenant({ id: A, slug: A, name: "DB Smoke A" }) });
    await prisma.tenant.create({ data: makeTenant({ id: B, slug: B, name: "DB Smoke B" }) });

    await prisma.paymentLink.create({
      data: makePaymentLink({
        id: `${A}-link`,
        tenantId: A,
        slug: `${A}-link`,
        amount: centimesToMad(centimes(123456)), // 1234.56 MAD
      }),
    });
    await prisma.paymentLink.create({
      data: makePaymentLink({ id: `${B}-link`, tenantId: B, slug: `${B}-link`, amount: 100 }),
    });

    await prisma.paymentIntent.create({
      data: makePaymentIntent({
        id: `${A}-intent`,
        tenantId: A,
        paymentLinkId: `${A}-link`,
        correlationId: "db-smoke-corr",
      }),
    });

    await prisma.webhookEvent.create({
      data: makeWebhookEvent({
        id: `${A}-webhook`,
        tenantId: A,
        paymentIntentId: `${A}-intent`,
        idempotencyKey: "db-smoke-idem",
      }),
    });
  });

  afterAll(async () => {
    // WebhookEvent has an *optional* tenant relation (onDelete: SetNull), so
    // delete it explicitly before removing the tenants.
    await prisma.webhookEvent.deleteMany({ where: { id: { in: [`${A}-webhook`] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it("round-trips money through a real Decimal(12,2) column", async () => {
    const row = await prisma.paymentLink.findUniqueOrThrow({ where: { id: `${A}-link` } });
    expect(madToCentimes(row.amount)).toBe(123456);
    expect(centimesToMadString(centimes(123456))).toBe("1234.56");
  });

  it("scopes tenant queries via forTenant()", async () => {
    expect(await forTenant(A).paymentLink.count()).toBe(1);
    expect(await forTenant(B).paymentLink.count()).toBe(1);
    expect(await forTenant(A).paymentLink.findFirst({ where: { slug: `${B}-link` } })).toBeNull();
  });

  it("rejects a duplicate payment-intent correlationId (P2002)", async () => {
    await expect(
      prisma.paymentIntent.create({
        data: makePaymentIntent({
          id: `${A}-intent-dup`,
          tenantId: A,
          paymentLinkId: null,
          correlationId: "db-smoke-corr",
        }),
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects a duplicate webhook idempotencyKey (P2002)", async () => {
    await expect(
      prisma.webhookEvent.create({
        data: makeWebhookEvent({
          id: `${A}-webhook-dup`,
          tenantId: A,
          paymentIntentId: `${A}-intent`,
          idempotencyKey: "db-smoke-idem",
        }),
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("cascades a tenant delete to required children", async () => {
    const C = "db-smoke-c";
    await prisma.tenant.create({ data: makeTenant({ id: C, slug: C, name: "DB Smoke C" }) });
    await prisma.user.create({
      data: makeUser({ id: `${C}-user`, tenantId: C, email: `${C}@test.local` }),
    });
    await prisma.tenant.delete({ where: { id: C } });
    expect(await prisma.user.count({ where: { tenantId: C } })).toBe(0);
  });
});
