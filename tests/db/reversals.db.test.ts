import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { credit, debit, posting } from "@/lib/ledger";
import { getTenantLedger, postEntry } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { createSettlementPolicy } from "@/lib/policy-db";
import { prisma } from "@/lib/prisma";
import { ReversalError } from "@/lib/reversals";
import { createDispute, resolveDispute } from "@/lib/reversals-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres reversal suite. Verifies what a mock cannot: a lost dispute
 * claws the gross back from the tenant's ledger (AVAILABLE and/or RESERVE
 * against CASH), stays balanced, and records any uncovered shortfall as a
 * `Recovery` receivable — all idempotent by `providerDisputeId`.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "reversals-db-a";

async function seedAccount(account: "AVAILABLE" | "RESERVE", cents: number): Promise<void> {
  await postEntry(
    TENANT,
    posting(debit("CASH", centimes(cents), "CAPTURE"), credit(account, centimes(cents), "CAPTURE")),
  );
}

describe("reversals persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Reversals DB A" }),
    });
  });

  afterAll(async () => {
    // recoveries cascade from disputes; disputes' paymentIntentId is SET NULL.
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
  });

  it("records a dispute and replays the same providerDisputeId idempotently", async () => {
    const d1 = await createDispute(TENANT, {
      providerDisputeId: "dp_1",
      provider: "VPS",
      amountCents: centimes(10000),
    });
    expect(d1.status).toBe("OPEN");
    expect(d1.amount.toString()).toBe("100");

    const d2 = await createDispute(TENANT, {
      providerDisputeId: "dp_1",
      provider: "VPS",
      amountCents: centimes(10000),
    });
    expect(d2.id).toBe(d1.id);
    expect(await prisma.dispute.count({ where: { tenantId: TENANT } })).toBe(1);
  });

  it("resolves to WON with no money movement", async () => {
    await seedAccount("AVAILABLE", 50000);
    const dispute = await createDispute(TENANT, {
      providerDisputeId: "dp_won",
      provider: "VPS",
      amountCents: centimes(50000),
    });

    const won = await resolveDispute(TENANT, dispute.id, "WON");
    expect(won.status).toBe("WON");

    const view = await getTenantLedger(TENANT);
    expect(view.balances.AVAILABLE).toBe(50000); // untouched
    expect(view.balances.RESERVE).toBe(0);
  });

  it("resolves to LOST and claws the gross back from AVAILABLE (NET_FROM_AVAILABLE)", async () => {
    await seedAccount("AVAILABLE", 50000);
    const dispute = await createDispute(TENANT, {
      providerDisputeId: "dp_lost",
      provider: "VPS",
      amountCents: centimes(50000),
    });

    const lost = await resolveDispute(TENANT, dispute.id, "LOST");
    expect(lost.status).toBe("LOST");
    expect(lost.recovery).toBeNull();

    const view = await getTenantLedger(TENANT);
    expect(view.balanced).toBe(true);
    expect(view.balances.AVAILABLE).toBe(0); // fully clawed back
    expect(view.balances.CASH).toBe(0); // pool restored
  });

  it("records a Recovery for the uncovered shortfall", async () => {
    await seedAccount("AVAILABLE", 10000); // only 100.00 MAD available
    const dispute = await createDispute(TENANT, {
      providerDisputeId: "dp_shortfall",
      provider: "VPS",
      amountCents: centimes(50000),
    });

    const lost = await resolveDispute(TENANT, dispute.id, "LOST");
    expect(lost.status).toBe("LOST");
    expect(lost.recovery).not.toBeNull();
    expect(lost.recovery?.status).toBe("PENDING");
    expect(lost.recovery?.amount.toString()).toBe("400"); // 400.00 MAD uncovered
  });

  it("draws the reserve down first under DEBIT_RESERVE", async () => {
    await createSettlementPolicy(TENANT, {
      industry: "travel",
      reversalFunding: "DEBIT_RESERVE",
      reserveType: "NONE",
    });
    await seedAccount("AVAILABLE", 10000);
    await seedAccount("RESERVE", 40000);

    const dispute = await createDispute(TENANT, {
      providerDisputeId: "dp_reserve",
      provider: "VPS",
      amountCents: centimes(50000),
    });
    const lost = await resolveDispute(TENANT, dispute.id, "LOST");
    expect(lost.status).toBe("LOST");

    const view = await getTenantLedger(TENANT);
    expect(view.balances.RESERVE).toBe(0); // reserve fully drawn
    expect(view.balances.AVAILABLE).toBe(0); // remainder from available
    expect(view.balanced).toBe(true);
  });

  it("refuses to resolve a terminal dispute twice", async () => {
    const dispute = await createDispute(TENANT, {
      providerDisputeId: "dp_twice",
      provider: "VPS",
      amountCents: centimes(10000),
    });
    await resolveDispute(TENANT, dispute.id, "WON");

    await expect(resolveDispute(TENANT, dispute.id, "LOST")).rejects.toThrow(ReversalError);
  });
});
