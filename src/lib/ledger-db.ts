/**
 * Ledger persistence + read views.
 *
 * `postEntry` writes a balanced `LedgerPosting` as two immutable `LedgerEntry`
 * rows (one debit, one credit) inside a transaction, each carrying a
 * `balanceAfter` audit snapshot for its account. `getTenantLedger` derives the
 * authoritative balance by summing entries (never from the stored snapshot).
 *
 * Amounts cross this module's boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import { randomUUID } from "node:crypto";

import type {
  LedgerAccount,
  LedgerCategory,
  LedgerDirection,
  Prisma,
} from "@/generated/prisma/client";

import {
  computeBalances,
  delta,
  isBalanced,
  type LedgerLeg,
  type LedgerPosting,
  posting,
} from "./ledger";
import { type Centimes, centimes, centimesToMad, madToCentimes } from "./money";
import { prisma } from "./prisma";

export interface PostedEntry {
  id: string;
  postingId: string;
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: Centimes;
  balanceAfterCents: Centimes;
  partyId: string | null;
}

export interface LedgerView {
  balances: Record<LedgerAccount, Centimes>;
  balanced: boolean;
  entries: Array<{
    id: string;
    postingId: string;
    account: LedgerAccount;
    direction: LedgerDirection;
    category: LedgerCategory;
    amountCents: Centimes;
    balanceAfterCents: Centimes;
    sourceType: string | null;
    sourceId: string | null;
    partyId: string | null;
    createdAt: Date;
  }>;
}

/** Current balance of one account (Σ credits − Σ debits), read from stored rows. */
async function accountBalanceCents(
  client: Prisma.TransactionClient,
  tenantId: string,
  account: LedgerAccount,
): Promise<Centimes> {
  const rows = await client.ledgerEntry.groupBy({
    by: ["direction"],
    where: { tenantId, account },
    _sum: { amount: true },
  });
  let balance = 0;
  for (const row of rows) {
    const cents = row._sum.amount != null ? madToCentimes(row._sum.amount) : 0;
    balance += row.direction === "CREDIT" ? cents : -cents;
  }
  return centimes(balance);
}

/**
 * Persist a posting as a debit + credit `LedgerEntry` pair.
 *
 * Re-validates the posting, then writes both legs atomically. `balanceAfter` for
 * each leg is `prior balance ± leg delta`. The two legs always touch different
 * accounts (enforced by `posting`), so there is no intra-posting ordering.
 *
 * Pass an outer `tx` to compose this into a larger transaction (e.g. a payout or
 * reversal that must move money and flip a status atomically). Without one, it
 * opens its own transaction.
 */
export async function postEntry(
  tenantId: string,
  p: LedgerPosting,
  tx?: Prisma.TransactionClient,
): Promise<{ postingId: string; entries: [PostedEntry, PostedEntry] }> {
  posting(p.debit, p.credit, { sourceType: p.sourceType, sourceId: p.sourceId });
  const postingId = randomUUID();

  const write = async (client: Prisma.TransactionClient): Promise<[PostedEntry, PostedEntry]> => {
    // Serialize money movement for this tenant so the balanceAfter snapshot is
    // computed against a stable balance (prevents a lost update on the audit
    // field under concurrent postings). Transaction-scoped; released on commit.
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    const debitAfter = centimes(
      (await accountBalanceCents(client, tenantId, p.debit.account)) + delta(p.debit),
    );
    const creditAfter = centimes(
      (await accountBalanceCents(client, tenantId, p.credit.account)) + delta(p.credit),
    );

    const debitRow = await client.ledgerEntry.create({
      data: {
        postingId,
        tenantId,
        account: p.debit.account,
        direction: "DEBIT",
        category: p.debit.category,
        amount: centimesToMad(p.debit.amountCents),
        currency: "MAD",
        balanceAfter: centimesToMad(debitAfter),
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        partyId: p.debit.partyId ?? null,
      },
    });
    const creditRow = await client.ledgerEntry.create({
      data: {
        postingId,
        tenantId,
        account: p.credit.account,
        direction: "CREDIT",
        category: p.credit.category,
        amount: centimesToMad(p.credit.amountCents),
        currency: "MAD",
        balanceAfter: centimesToMad(creditAfter),
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        partyId: p.credit.partyId ?? null,
      },
    });

    return [
      {
        id: debitRow.id,
        postingId,
        account: debitRow.account,
        direction: debitRow.direction,
        amountCents: madToCentimes(debitRow.amount),
        balanceAfterCents: madToCentimes(debitRow.balanceAfter),
        partyId: debitRow.partyId,
      },
      {
        id: creditRow.id,
        postingId,
        account: creditRow.account,
        direction: creditRow.direction,
        amountCents: madToCentimes(creditRow.amount),
        balanceAfterCents: madToCentimes(creditRow.balanceAfter),
        partyId: creditRow.partyId,
      },
    ] as [PostedEntry, PostedEntry];
  };

  const entries = tx ? await write(tx) : await prisma.$transaction(write);
  return { postingId, entries };
}

/**
 * Derive a tenant's ledger: per-account balances (from summing entries — the
 * authoritative path), the global balance invariant, and the raw entries.
 *
 * Phase-1 scale reads every entry for the tenant. When the payout engine lands,
 * this folds into a cached balance + paginated entries without changing the
 * returned shape (see the PayFac design doc).
 */
export async function getTenantLedger(tenantId: string): Promise<LedgerView> {
  const rows = await prisma.ledgerEntry.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const legs: LedgerLeg[] = rows.map((row) => ({
    account: row.account,
    direction: row.direction,
    amountCents: madToCentimes(row.amount),
    category: row.category,
  }));

  return {
    balances: computeBalances(legs),
    balanced: isBalanced(legs),
    entries: rows.map((row) => ({
      id: row.id,
      postingId: row.postingId,
      account: row.account,
      direction: row.direction,
      category: row.category,
      amountCents: madToCentimes(row.amount),
      balanceAfterCents: madToCentimes(row.balanceAfter),
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      partyId: row.partyId,
      createdAt: row.createdAt,
    })),
  };
}
