import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { credit, debit, posting } from "@/lib/ledger";
import { getTenantLedger, postEntry } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { PayoutError } from "@/lib/payout";
import {
  cancelPayout,
  createPayout,
  getPayout,
  markPayoutFailed,
  markPayoutPaid,
} from "@/lib/payout-db";
import { prisma } from "@/lib/prisma";
import { makeTenant } from "../factories";

/**
 * Real-Postgres payout suite. Verifies what a mock cannot: a payout snapshots
 * eligible AVAILABLE credits into `PayoutItem` rows (unique per ledger entry, so
 * each entry settles at most once), idempotency by `idempotencyKey`, and the
 * settlement movement debits AVAILABLE and credits PAID_OUT.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "payout-db-a";

/** Seed `cents` centimes of eligible AVAILABLE balance for the tenant. */
async function seedAvailable(cents: number): Promise<void> {
  await postEntry(
    TENANT,
    posting(
      debit("CASH", centimes(cents), "CAPTURE"),
      credit("AVAILABLE", centimes(cents), "CAPTURE"),
    ),
  );
}

describe("payout persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Payout DB A" }),
    });
  });

  afterAll(async () => {
    // Order matters: payout_items → ledger_entries is ON DELETE RESTRICT.
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("snapshots eligible AVAILABLE credits into a DRAFT payout", async () => {
    await seedAvailable(50000); // 500.00 MAD

    const payout = await createPayout(TENANT, {
      idempotencyKey: "payout-1",
      provider: "VPS",
    });

    expect(payout.status).toBe("DRAFT");
    expect(payout.amount.toString()).toBe("500");
    expect(payout.items).toHaveLength(1);
    expect(payout.items[0].amount.toString()).toBe("500");
  });

  it("replays the same idempotencyKey without double-reserving funds", async () => {
    await seedAvailable(50000);

    const first = await createPayout(TENANT, { idempotencyKey: "payout-1", provider: "VPS" });
    const second = await createPayout(TENANT, { idempotencyKey: "payout-1", provider: "VPS" });

    expect(second.id).toBe(first.id);
    expect(second.items).toHaveLength(1);
    expect(await prisma.payout.count({ where: { tenantId: TENANT } })).toBe(1);
  });

  it("refuses a second payout once funds are reserved", async () => {
    await seedAvailable(50000);
    await createPayout(TENANT, { idempotencyKey: "payout-1", provider: "VPS" });

    await expect(
      createPayout(TENANT, { idempotencyKey: "payout-2", provider: "VPS" }),
    ).rejects.toThrow(PayoutError);
  });

  it("throws when there are no eligible funds", async () => {
    await expect(
      createPayout(TENANT, { idempotencyKey: "payout-empty", provider: "VPS" }),
    ).rejects.toThrow(/no eligible funds/);
  });

  it("markPayoutPaid settles AVAILABLE → PAID_OUT and flips status", async () => {
    await seedAvailable(50000);
    const payout = await createPayout(TENANT, { idempotencyKey: "payout-1", provider: "VPS" });

    const paid = await markPayoutPaid(TENANT, payout.id, "provider-transfer-1");
    expect(paid.status).toBe("PAID");
    expect(paid.providerTransferId).toBe("provider-transfer-1");

    const view = await getTenantLedger(TENANT);
    expect(view.balanced).toBe(true);
    expect(view.balances.AVAILABLE).toBe(0);
    expect(view.balances.PAID_OUT).toBe(50000);
  });

  it("markPayoutFailed and cancelPayout reach their terminal states", async () => {
    await seedAvailable(50000);
    const fail = await createPayout(TENANT, { idempotencyKey: "payout-fail", provider: "VPS" });
    expect((await markPayoutFailed(TENANT, fail.id)).status).toBe("FAILED");

    // A fresh batch of available funds so the second payout has something to reserve.
    await seedAvailable(50000);
    const cancel = await createPayout(TENANT, { idempotencyKey: "payout-cancel", provider: "VPS" });
    expect((await cancelPayout(TENANT, cancel.id)).status).toBe("CANCELLED");

    // Terminal states never pay out a second time.
    await expect(markPayoutPaid(TENANT, fail.id)).rejects.toThrow(PayoutError);
  });

  it("getPayout returns null for a missing payout", async () => {
    expect(await getPayout(TENANT, "missing")).toBeNull();
  });
});
