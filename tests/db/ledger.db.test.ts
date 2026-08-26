import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { credit, debit, posting } from "@/lib/ledger";
import { getTenantLedger, postEntry } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { forTenant } from "@/lib/tenant-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres ledger suite. Verifies what a mock cannot: `postEntry` writes a
 * balanced debit+credit pair atomically, `balanceAfter` accumulates correctly,
 * and the authoritative balance is derived (never read from a stored counter).
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "ledger-db-a";

describe("ledger persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Ledger DB A" }),
    });
  });

  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("postEntry writes a balanced debit+credit pair with balanceAfter snapshots", async () => {
    const { postingId, entries } = await postEntry(
      TENANT,
      posting(
        debit("CASH", centimes(100000), "CAPTURE"),
        credit("COLLECTED", centimes(100000), "CAPTURE"),
        { sourceType: "payment_intent", sourceId: "pi-ledger-1" },
      ),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].postingId).toBe(postingId);
    expect(entries[1].postingId).toBe(postingId);

    const debitEntry = entries.find((e) => e.direction === "DEBIT");
    const creditEntry = entries.find((e) => e.direction === "CREDIT");
    expect(debitEntry?.account).toBe("CASH");
    expect(debitEntry?.amountCents).toBe(100000);
    expect(debitEntry?.balanceAfterCents).toBe(-100000);
    expect(creditEntry?.account).toBe("COLLECTED");
    expect(creditEntry?.amountCents).toBe(100000);
    expect(creditEntry?.balanceAfterCents).toBe(100000);
  });

  it("accumulates balanceAfter across postings and derives the authoritative balance", async () => {
    await postEntry(
      TENANT,
      posting(
        debit("CASH", centimes(100000), "CAPTURE"),
        credit("COLLECTED", centimes(100000), "CAPTURE"),
      ),
    );
    await postEntry(
      TENANT,
      posting(debit("COLLECTED", centimes(1000), "FEE"), credit("FEES", centimes(1000), "FEE")),
    );

    const view = await getTenantLedger(TENANT);
    expect(view.balanced).toBe(true);
    expect(view.balances.CASH).toBe(-100000);
    expect(view.balances.COLLECTED).toBe(99000);
    expect(view.balances.FEES).toBe(1000);

    const total = Object.values(view.balances).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
    expect(view.entries).toHaveLength(4);
  });

  it("scopes ledger reads by tenant via forTenant", async () => {
    await postEntry(
      TENANT,
      posting(
        debit("CASH", centimes(5000), "CAPTURE"),
        credit("COLLECTED", centimes(5000), "CAPTURE"),
      ),
    );

    const db = forTenant(TENANT);
    const rows = await db.ledgerEntry.findMany({});
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.tenantId).toBe(TENANT);
  });
});
