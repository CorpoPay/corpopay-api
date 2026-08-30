import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { credit, debit, posting } from "@/lib/ledger";
import { postEntry } from "@/lib/ledger-db";
import { centimes, madToCentimes } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  createSettlementStatement,
  finalizeSettlementStatement,
  getSettlementStatement,
  listSettlementStatements,
  voidSettlementStatement,
} from "@/lib/statements-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres settlement statement suite. Verifies what a mock cannot: that a
 * statement snapshots the tenant ledger (opening/closing AVAILABLE balance, net,
 * and per-category gross volume) and that the DRAFT → FINALIZED → VOID lifecycle
 * persists.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "statements-db-a";
const PERIOD_START = new Date("2000-01-01T00:00:00Z");
const PERIOD_END = new Date("2100-01-01T00:00:00Z");

async function seedLedger(
  sourceId: string,
  category: "CAPTURE" | "PAYOUT",
  cents: number,
): Promise<void> {
  if (category === "CAPTURE") {
    await postEntry(
      TENANT,
      posting(
        debit("CASH", centimes(cents), "CAPTURE"),
        credit("AVAILABLE", centimes(cents), "CAPTURE"),
        {
          sourceType: "capture",
          sourceId,
        },
      ),
    );
  } else {
    await postEntry(
      TENANT,
      posting(
        debit("AVAILABLE", centimes(cents), "PAYOUT"),
        credit("PAID_OUT", centimes(cents), "PAYOUT"),
        {
          sourceType: "payout",
          sourceId,
        },
      ),
    );
  }
}

describe("settlement statement persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.settlementStatementItem.deleteMany({ where: { statement: { tenantId: TENANT } } });
    await prisma.settlementStatement.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Statements DB A" }),
    });
  });

  afterAll(async () => {
    await prisma.settlementStatementItem.deleteMany({ where: { statement: { tenantId: TENANT } } });
    await prisma.settlementStatement.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.settlementStatementItem.deleteMany({ where: { statement: { tenantId: TENANT } } });
    await prisma.settlementStatement.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("snapshots an empty ledger into a zeroed statement", async () => {
    const statement = await createSettlementStatement(TENANT, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(statement.status).toBe("DRAFT");
    expect(madToCentimes(statement.netAmount)).toBe(0);
    expect(statement.items).toHaveLength(0);
    expect((await listSettlementStatements(TENANT)).length).toBe(1);
    expect((await getSettlementStatement(TENANT, statement.id))?.id).toBe(statement.id);
  });

  it("itemizes capture and payout volume and the net AVAILABLE change", async () => {
    await seedLedger("capture-1", "CAPTURE", 10_000);
    await seedLedger("payout-1", "PAYOUT", 8_000);

    const statement = await createSettlementStatement(TENANT, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    expect(madToCentimes(statement.openingBalance)).toBe(0);
    expect(madToCentimes(statement.closingBalance)).toBe(2000);
    expect(madToCentimes(statement.netAmount)).toBe(2000);

    const items = Object.fromEntries(statement.items.map((i) => [i.category, i]));
    expect(madToCentimes(items.CAPTURE.amount)).toBe(10000);
    expect(items.CAPTURE.entryCount).toBe(1);
    expect(madToCentimes(items.PAYOUT.amount)).toBe(8000);
    expect(items.PAYOUT.entryCount).toBe(1);
  });

  it("computes a non-zero opening balance from entries before the window", async () => {
    await seedLedger("capture-1", "CAPTURE", 10_000);

    // Statement for a window strictly after the seeded entry: opening carries the
    // pre-window balance, but the window itself is empty.
    const statement = await createSettlementStatement(TENANT, {
      periodStart: new Date(Date.now() + 60_000),
      periodEnd: new Date(Date.now() + 120_000),
    });
    expect(madToCentimes(statement.openingBalance)).toBe(10000);
    expect(madToCentimes(statement.closingBalance)).toBe(10000);
    expect(madToCentimes(statement.netAmount)).toBe(0);
    expect(statement.items).toHaveLength(0);
  });

  it("finalizes then voids a statement", async () => {
    const statement = await createSettlementStatement(TENANT, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const finalized = await finalizeSettlementStatement(TENANT, statement.id);
    expect(finalized.status).toBe("FINALIZED");
    expect(finalized.finalizedAt).not.toBeNull();

    const voided = await voidSettlementStatement(TENANT, statement.id);
    expect(voided.status).toBe("VOID");
  });
});
