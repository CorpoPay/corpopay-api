import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { credit, debit, posting } from "@/lib/ledger";
import { postEntry } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  createReconciliationReport,
  getReconciliationReport,
  listReconciliationReports,
  resolveReconciliation,
  runReconciliation,
} from "@/lib/reconciliation-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres reconciliation suite. Verifies what a mock cannot: that a report
 * matches the tenant ledger (summed per `sourceId` DEBIT legs), that per-line
 * status / matchedAmount / differenceAmount persist, and that the report-level
 * status + summary flip MATCHED/UNMATCHED/RESOLVED correctly.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "recon-db-a";

async function seedLedger(sourceId: string, cents: number): Promise<void> {
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

describe("reconciliation persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.reconciliationLine.deleteMany({ where: { report: { tenantId: TENANT } } });
    await prisma.reconciliationReport.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Recon DB A" }),
    });
  });

  afterAll(async () => {
    await prisma.reconciliationLine.deleteMany({ where: { report: { tenantId: TENANT } } });
    await prisma.reconciliationReport.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.reconciliationLine.deleteMany({ where: { report: { tenantId: TENANT } } });
    await prisma.reconciliationReport.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("creates and lists a report", async () => {
    const report = await createReconciliationReport(TENANT, {
      provider: "VPS",
      lines: [{ reference: "payout-1", amountCents: centimes(10_000) }],
    });
    expect(report.status).toBe("PENDING");
    expect(report.lines).toHaveLength(1);
    expect((await listReconciliationReports(TENANT)).length).toBe(1);
    expect((await getReconciliationReport(TENANT, report.id))?.id).toBe(report.id);
  });

  it("matches an exact ledger posting and marks the report MATCHED", async () => {
    await seedLedger("payout-1", 10_000);

    const report = await createReconciliationReport(TENANT, {
      provider: "VPS",
      lines: [{ reference: "payout-1", amountCents: centimes(10_000) }],
    });

    const run = await runReconciliation(TENANT, report.id);
    expect(run.status).toBe("MATCHED");
    expect(run.lines[0].status).toBe("EXACT");
    expect(run.lines[0].matchedAmount?.toString()).toBe("100");
    expect(run.lines[0].differenceAmount?.toString()).toBe("0");
    expect(run.summary).toMatchObject({ exactCount: 1, netDifferenceCents: 0 });
  });

  it("flags an amount difference and a provider-only break as UNMATCHED", async () => {
    await seedLedger("payout-1", 10_000);

    const report = await createReconciliationReport(TENANT, {
      provider: "VPS",
      lines: [
        { reference: "payout-1", amountCents: centimes(9_999) }, // AMOUNT_DIFF (−1 cent)
        { reference: "payout-2", amountCents: centimes(5_000) }, // provider-only
      ],
    });

    const run = await runReconciliation(TENANT, report.id);
    expect(run.status).toBe("UNMATCHED");
    expect(run.summary).toMatchObject({ amountDiffCount: 1 });
    expect(run.summary.missingInternal).toEqual([{ reference: "payout-2", amountCents: 5000 }]);
    const diffLine = run.lines.find((l) => l.reference === "payout-1");
    expect(diffLine?.status).toBe("AMOUNT_DIFF");
    expect(diffLine?.differenceAmount?.toString()).toBe("-0.01");
    expect(diffLine?.matchedAmount?.toString()).toBe("100");
  });

  it("detects a ledger-only movement the report never mentioned", async () => {
    await seedLedger("payout-1", 10_000);

    const report = await createReconciliationReport(TENANT, {
      provider: "VPS",
      lines: [{ reference: "payout-1", amountCents: centimes(10_000) }],
    });
    await runReconciliation(TENANT, report.id);

    // Add a second ledger movement after the first run, then re-run.
    await seedLedger("payout-2", 4_000);
    const run = await runReconciliation(TENANT, report.id);
    expect(run.status).toBe("UNMATCHED");
    expect(run.summary.missingExternal).toEqual([{ reference: "payout-2", amountCents: 4000 }]);
    expect(run.summary.netDifferenceCents).toBe(-4000);
  });

  it("resolves a report to a terminal state", async () => {
    const report = await createReconciliationReport(TENANT, {
      provider: "VPS",
      lines: [{ reference: "x", amountCents: centimes(1) }],
    });
    await runReconciliation(TENANT, report.id);
    const resolved = await resolveReconciliation(TENANT, report.id);
    expect(resolved.status).toBe("RESOLVED");
  });
});
