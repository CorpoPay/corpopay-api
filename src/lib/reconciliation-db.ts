/**
 * Reconciliation persistence + the three-way match against the tenant ledger.
 *
 * A reconciliation report ingests a provider **statement** (a list of external
 * lines: a `reference` + an amount) and matches it against the tenant's internal
 * **ledger**. `runReconciliation` derives the internal side by summing each
 * `sourceId`'s DEBIT legs (the gross money moved by that source), runs the pure
 * `reconcile()` matcher, and persists the outcome: per-line `status` /
 * `matchedAmount` / `differenceAmount`, plus a report-level `summary` (counts,
 * totals, and the internal-only breaks the line list cannot express).
 *
 * Amounts cross this module's boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */

import type { Provider, ReconciliationLine, ReconciliationReport } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

import { type Centimes, centimes, centimesToMad, madToCentimes } from "./money";
import { prisma } from "./prisma";
import {
  assertTransition,
  type InternalLine,
  isClean,
  ReconciliationError,
  reconcile,
} from "./reconciliation";

export type ReconciliationReportWithLines = ReconciliationReport & {
  lines: ReconciliationLine[];
};

interface CreateReportLineInput {
  reference: string;
  amountCents: Centimes;
}

export interface CreateReconciliationReportInput {
  provider: Provider;
  currency?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  lines: CreateReportLineInput[];
}

export async function createReconciliationReport(
  tenantId: string,
  input: CreateReconciliationReportInput,
): Promise<ReconciliationReportWithLines> {
  const currency = input.currency ?? "MAD";
  return prisma.reconciliationReport.create({
    data: {
      tenantId,
      provider: input.provider,
      currency,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      status: "PENDING",
      summary: Prisma.DbNull,
      lines: {
        create: input.lines.map((line) => ({
          reference: line.reference,
          amount: centimesToMad(line.amountCents),
          currency,
          status: "UNMATCHED",
        })),
      },
    },
    include: { lines: true },
  });
}

export async function listReconciliationReports(
  tenantId: string,
): Promise<ReconciliationReportWithLines[]> {
  return prisma.reconciliationReport.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: { lines: true },
  });
}

export async function getReconciliationReport(
  tenantId: string,
  id: string,
): Promise<ReconciliationReportWithLines | null> {
  return prisma.reconciliationReport.findFirst({
    where: { id, tenantId },
    include: { lines: true },
  });
}

/**
 * Derive the internal (ledger) side of the match: sum each `sourceId`'s DEBIT
 * legs. Every balanced posting has exactly one debit leg of the gross amount, so
 * summing debits per source yields the total money moved by that source — the
 * same figure a provider report line should agree with.
 */
async function buildInternalLines(tenantId: string): Promise<InternalLine[]> {
  const rows = await prisma.ledgerEntry.findMany({
    where: { tenantId, sourceId: { not: null }, direction: "DEBIT" },
    select: { sourceId: true, amount: true },
  });
  const bySource = new Map<string, number>();
  for (const row of rows) {
    const reference = row.sourceId as string;
    bySource.set(reference, (bySource.get(reference) ?? 0) + madToCentimes(row.amount));
  }
  return [...bySource.entries()].map(([reference, amountCents]) => ({
    reference,
    amountCents: centimes(amountCents),
  }));
}

/**
 * Match the report's external lines against the tenant ledger and persist the
 * outcome. Idempotent + re-runnable: a repeat run (or a run after the ledger is
 * fixed) reclassifies the lines and flips the report between MATCHED/UNMATCHED.
 */
export async function runReconciliation(
  tenantId: string,
  id: string,
): Promise<ReconciliationReportWithLines> {
  const report = await prisma.reconciliationReport.findFirst({
    where: { id, tenantId },
    include: { lines: true },
  });
  if (!report) throw new ReconciliationError("reconciliation report not found");

  const external = report.lines.map((line) => ({
    reference: line.reference,
    amountCents: madToCentimes(line.amount),
  }));
  const internal = await buildInternalLines(tenantId);
  const result = reconcile(external, internal);
  const nextStatus = isClean(result) ? "MATCHED" : "UNMATCHED";

  if (report.status !== nextStatus) {
    assertTransition(report.status, nextStatus);
  }

  const summary = {
    exactCount: result.matches.filter((m) => m.status === "EXACT").length,
    amountDiffCount: result.matches.filter((m) => m.status === "AMOUNT_DIFF").length,
    missingInternal: result.missingInternal.map((line) => ({
      reference: line.reference,
      amountCents: line.amountCents,
    })),
    missingExternal: result.missingExternal.map((line) => ({
      reference: line.reference,
      amountCents: line.amountCents,
    })),
    externalTotalCents: result.externalTotalCents,
    internalTotalCents: result.internalTotalCents,
    netDifferenceCents: result.netDifferenceCents,
  };

  const outcomeByRef = new Map<
    string,
    { status: ReconciliationLine["status"]; matchedCents: Centimes | null; diffCents: Centimes }
  >();
  for (const match of result.matches) {
    outcomeByRef.set(match.reference, {
      status: match.status,
      matchedCents: match.internalCents,
      diffCents: match.differenceCents,
    });
  }
  for (const missing of result.missingInternal) {
    outcomeByRef.set(missing.reference, {
      status: "UNMATCHED",
      matchedCents: null,
      diffCents: missing.amountCents,
    });
  }

  return prisma.$transaction(async (tx) => {
    for (const line of report.lines) {
      const outcome = outcomeByRef.get(line.reference);
      if (!outcome) continue;
      await tx.reconciliationLine.update({
        where: { id: line.id },
        data: {
          status: outcome.status,
          matchedAmount: outcome.matchedCents != null ? centimesToMad(outcome.matchedCents) : null,
          differenceAmount: centimesToMad(outcome.diffCents),
        },
      });
    }

    await tx.reconciliationReport.update({
      where: { id },
      data: { status: nextStatus, summary: summary as unknown as Prisma.InputJsonValue },
    });

    return (await tx.reconciliationReport.findUnique({
      where: { id },
      include: { lines: true },
    })) as ReconciliationReportWithLines;
  });
}

/** Close a report after review (terminal). */
export async function resolveReconciliation(
  tenantId: string,
  id: string,
): Promise<ReconciliationReport> {
  const report = await prisma.reconciliationReport.findFirst({ where: { id, tenantId } });
  if (!report) throw new ReconciliationError("reconciliation report not found");
  assertTransition(report.status, "RESOLVED");
  return prisma.reconciliationReport.update({
    where: { id },
    data: { status: "RESOLVED" },
  });
}
