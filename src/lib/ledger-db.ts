/**
 * Ledger persistence + read views.
 *
 * `postEntry` writes a balanced `LedgerPosting` as two immutable `LedgerEntry`
 * rows (one debit, one credit) inside a transaction, each carrying a
 * `balanceAfter` audit snapshot for its (account, currency). `getTenantLedger`
 * derives the authoritative balance by summing entries (never from the stored
 * snapshot).
 *
 * Multi-currency (ADR 0006): every posting is single-currency and every entry
 * stores its ISO 4217 `currency`. `getTenantLedger` returns the authoritative
 * per-currency `balancesByCurrency` plus a MAD-only `balances` projection kept
 * for backward-compatible consumers (routes/adapters migrate off it in a later
 * phase). Amounts cross this module's boundary as integer minor units; the DB
 * stores major units `Decimal(12,2)` — every conversion goes through `money.ts`.
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
  computeBalancesByCurrency,
  delta,
  isBalanced,
  type LedgerBalances,
  type LedgerLeg,
  type LedgerPosting,
  posting,
} from "./ledger";
import { type Centimes, type Currency, centimes, fromMinor, toMinor } from "./money";
import { prisma } from "./prisma";

export interface PostedEntry {
  id: string;
  postingId: string;
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: Centimes;
  balanceAfterCents: Centimes;
  currency: Currency;
  partyId: string | null;
}

export interface LedgerView {
  /** MAD-only projection of `balancesByCurrency` (backward-compatible shape). */
  balances: Record<LedgerAccount, Centimes>;
  /** Authoritative per-(account, currency) balances. */
  balancesByCurrency: LedgerBalances;
  balanced: boolean;
  entries: Array<{
    id: string;
    postingId: string;
    account: LedgerAccount;
    direction: LedgerDirection;
    category: LedgerCategory;
    amountCents: Centimes;
    balanceAfterCents: Centimes;
    currency: Currency;
    sourceType: string | null;
    sourceId: string | null;
    partyId: string | null;
    createdAt: Date;
  }>;
}

/** Current balance of one (account, currency) pair (Σ credits − Σ debits). */
export async function accountBalanceCents(
  client: Prisma.TransactionClient,
  tenantId: string,
  account: LedgerAccount,
  currency: Currency = "MAD",
): Promise<Centimes> {
  const rows = await client.ledgerEntry.groupBy({
    by: ["direction"],
    where: { tenantId, account, currency },
    _sum: { amount: true },
  });
  let balance = 0;
  for (const row of rows) {
    const minor = row._sum.amount != null ? toMinor(row._sum.amount, currency) : 0;
    balance += row.direction === "CREDIT" ? minor : -minor;
  }
  return centimes(balance);
}

/**
 * Persist a posting as a debit + credit `LedgerEntry` pair.
 *
 * Re-validates the posting, then writes both legs atomically. `balanceAfter` for
 * each leg is `prior balance ± leg delta` within that leg's currency. The two
 * legs always touch different accounts (enforced by `posting`), so there is no
 * intra-posting ordering.
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
  const currency = p.debit.currency;

  const write = async (client: Prisma.TransactionClient): Promise<[PostedEntry, PostedEntry]> => {
    // Serialize money movement for this tenant so the balanceAfter snapshot is
    // computed against a stable balance (prevents a lost update on the audit
    // field under concurrent postings). Transaction-scoped; released on commit.
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    const debitAfter = centimes(
      (await accountBalanceCents(client, tenantId, p.debit.account, currency)) + delta(p.debit),
    );
    const creditAfter = centimes(
      (await accountBalanceCents(client, tenantId, p.credit.account, currency)) + delta(p.credit),
    );

    const debitRow = await client.ledgerEntry.create({
      data: {
        postingId,
        tenantId,
        account: p.debit.account,
        direction: "DEBIT",
        category: p.debit.category,
        amount: fromMinor(p.debit.amountCents, currency),
        currency,
        balanceAfter: fromMinor(debitAfter, currency),
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
        amount: fromMinor(p.credit.amountCents, currency),
        currency,
        balanceAfter: fromMinor(creditAfter, currency),
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
        amountCents: toMinor(debitRow.amount, currency),
        balanceAfterCents: toMinor(debitRow.balanceAfter, currency),
        currency,
        partyId: debitRow.partyId,
      },
      {
        id: creditRow.id,
        postingId,
        account: creditRow.account,
        direction: creditRow.direction,
        amountCents: toMinor(creditRow.amount, currency),
        balanceAfterCents: toMinor(creditRow.balanceAfter, currency),
        currency,
        partyId: creditRow.partyId,
      },
    ] as [PostedEntry, PostedEntry];
  };

  const entries = tx ? await write(tx) : await prisma.$transaction(write);
  return { postingId, entries };
}

/**
 * Derive a tenant's ledger: per-(account, currency) balances (from summing
 * entries — the authoritative path), a MAD-only projection, the per-currency
 * balance invariant, and the raw entries.
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
    amountCents: toMinor(row.amount, row.currency as Currency),
    category: row.category,
    currency: row.currency as Currency,
  }));

  return {
    balances: computeBalances(legs),
    balancesByCurrency: computeBalancesByCurrency(legs),
    balanced: isBalanced(legs),
    entries: rows.map((row) => ({
      id: row.id,
      postingId: row.postingId,
      account: row.account,
      direction: row.direction,
      category: row.category,
      amountCents: toMinor(row.amount, row.currency as Currency),
      balanceAfterCents: toMinor(row.balanceAfter, row.currency as Currency),
      currency: row.currency as Currency,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      partyId: row.partyId,
      createdAt: row.createdAt,
    })),
  };
}
