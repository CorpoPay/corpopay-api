/**
 * Settlement statement persistence.
 *
 * `createSettlementStatement` snapshots a tenant's ledger over a period into a
 * `SettlementStatement` + per-category `SettlementStatementItem` rows. The
 * statement is immutable once finalized (the tenant can rely on a finalized
 * statement as a stable invoice/accounting artifact). `void` is the terminal
 * state for a statement that was generated in error.
 *
 * Amounts cross this module's boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { SettlementStatement, SettlementStatementItem } from "@/generated/prisma/client";

import { type Centimes, centimesToMad, madToCentimes } from "./money";
import { prisma } from "./prisma";
import {
  assertTransition,
  buildStatement,
  type StatementEntry,
  StatementError,
} from "./statements";

export type SettlementStatementWithItems = SettlementStatement & {
  items: SettlementStatementItem[];
};

export interface CreateSettlementStatementInput {
  periodStart: Date;
  periodEnd: Date;
  currency?: string;
}

export async function createSettlementStatement(
  tenantId: string,
  input: CreateSettlementStatementInput,
): Promise<SettlementStatementWithItems> {
  const rows = await prisma.ledgerEntry.findMany({
    where: { tenantId },
    select: { category: true, account: true, direction: true, amount: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const entries: StatementEntry[] = rows.map((row) => ({
    category: row.category,
    account: row.account,
    direction: row.direction,
    amountCents: madToCentimes(row.amount),
    createdAt: row.createdAt,
  }));

  const result = buildStatement(entries, input.periodStart, input.periodEnd);
  const currency = input.currency ?? "MAD";

  return prisma.settlementStatement.create({
    data: {
      tenantId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency,
      status: "DRAFT",
      openingBalance: centimesToMad(result.openingBalanceCents),
      closingBalance: centimesToMad(result.closingBalanceCents),
      netAmount: centimesToMad(result.netCents),
      items: {
        create: result.items.map((item) => ({
          category: item.category,
          amount: centimesToMad(item.amountCents),
          entryCount: item.entryCount,
        })),
      },
    },
    include: { items: true },
  });
}

export async function listSettlementStatements(
  tenantId: string,
): Promise<SettlementStatementWithItems[]> {
  return prisma.settlementStatement.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
}

export async function getSettlementStatement(
  tenantId: string,
  id: string,
): Promise<SettlementStatementWithItems | null> {
  return prisma.settlementStatement.findFirst({
    where: { id, tenantId },
    include: { items: true },
  });
}

/** Lock a statement — it becomes an immutable accounting artifact. */
export async function finalizeSettlementStatement(
  tenantId: string,
  id: string,
): Promise<SettlementStatement> {
  const statement = await prisma.settlementStatement.findFirst({ where: { id, tenantId } });
  if (!statement) throw new StatementError("settlement statement not found");
  assertTransition(statement.status, "FINALIZED");
  return prisma.settlementStatement.update({
    where: { id },
    data: { status: "FINALIZED", finalizedAt: new Date() },
  });
}

/** Void a statement generated in error (terminal). */
export async function voidSettlementStatement(
  tenantId: string,
  id: string,
): Promise<SettlementStatement> {
  const statement = await prisma.settlementStatement.findFirst({ where: { id, tenantId } });
  if (!statement) throw new StatementError("settlement statement not found");
  assertTransition(statement.status, "VOID");
  return prisma.settlementStatement.update({
    where: { id },
    data: { status: "VOID" },
  });
}
