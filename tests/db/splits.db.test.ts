import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { credit, debit, posting } from "@/lib/ledger";
import { getTenantLedger, postEntry } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  createSplitParty,
  createSplitRule,
  executeSplit,
  listSplitParties,
  listSplitRules,
  releaseSplit,
} from "@/lib/splits-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres split suite. Verifies what a mock cannot: the ledger postings a
 * split produces (debit the source, credit each party's AVAILABLE/RESERVE), the
 * platform remainder, and the escrow-release movement (RESERVE → AVAILABLE).
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "splits-db-a";

async function seedBalance(account: "COLLECTED" | "AVAILABLE", cents: number): Promise<void> {
  await postEntry(
    TENANT,
    posting(debit("CASH", centimes(cents), "CAPTURE"), credit(account, centimes(cents), "CAPTURE")),
  );
}

describe("split persistence (real Postgres)", () => {
  let hostId: string;

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.split.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitParty.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Splits DB A" }),
    });
    const party = await createSplitParty(TENANT, { slug: "host", name: "Host" });
    hostId = party.id;
  });

  afterAll(async () => {
    await prisma.split.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitParty.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.split.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("creates + lists split parties and rules", async () => {
    expect((await listSplitParties(TENANT)).some((p) => p.slug === "host")).toBe(true);

    await createSplitRule(TENANT, {
      name: "Marketplace",
      shares: [{ partyId: hostId, shareBps: 8000 }],
    });
    expect((await listSplitRules(TENANT)).some((r) => r.name === "Marketplace")).toBe(true);
  });

  it("AT_CAPTURE split credits the party and the platform", async () => {
    await seedBalance("COLLECTED", 10_000); // 100.00 MAD gross

    const splits = await executeSplit(TENANT, {
      sourceType: "payment_intent",
      sourceId: "intent-1",
      sourceCents: centimes(10_000),
      shares: [{ partyId: hostId, shareBps: 8000 }],
    });

    expect(splits).toHaveLength(1);
    expect(splits[0].status).toBe("SETTLED");
    expect(splits[0].amount.toString()).toBe("80");

    const view = await getTenantLedger(TENANT);
    expect(view.balanced).toBe(true);
    expect(view.balances.COLLECTED).toBe(0);
    expect(view.balances.AVAILABLE).toBe(10_000); // 8000 host + 2000 platform
  });

  it("held split holds in RESERVE then releases to AVAILABLE", async () => {
    await seedBalance("COLLECTED", 10_000);

    const splits = await executeSplit(TENANT, {
      sourceType: "payment_intent",
      sourceId: "intent-2",
      sourceCents: centimes(10_000),
      shares: [{ partyId: hostId, shareBps: 9000 }],
      held: true,
    });

    expect(splits[0].status).toBe("PENDING");
    let view = await getTenantLedger(TENANT);
    expect(view.balances.RESERVE).toBe(9000);
    expect(view.balances.AVAILABLE).toBe(1000); // platform remainder

    const released = await releaseSplit(TENANT, splits[0].id);
    expect(released.status).toBe("SETTLED");

    view = await getTenantLedger(TENANT);
    expect(view.balances.RESERVE).toBe(0);
    expect(view.balances.AVAILABLE).toBe(10_000);
  });

  it("ON_USAGE split debits AVAILABLE (prepaid wallet model)", async () => {
    await seedBalance("AVAILABLE", 2000); // 20.00 MAD wallet top-up

    const splits = await executeSplit(TENANT, {
      sourceType: "booking",
      sourceId: "booking-1",
      sourceCents: centimes(500),
      trigger: "ON_USAGE",
      shares: [{ partyId: hostId, shareBps: 9000 }],
      held: true,
    });

    expect(splits[0].status).toBe("PENDING");
    const view = await getTenantLedger(TENANT);
    expect(view.balances.AVAILABLE).toBe(1550); // 2000 − 450 debited; 50 platform stays
    expect(view.balances.RESERVE).toBe(450);
  });
});
