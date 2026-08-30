/**
 * Settlement statement engine (PayFac) — pure, centime-exact aggregation.
 *
 * A settlement statement is the **data** a tenant needs to reconcile their own
 * books and invoice their customers (CorpoPay generates the data; the tenant
 * sends the email). It snapshots a tenant's ledger over a `[periodStart,
 * periodEnd)` window:
 *
 *   - `openingBalanceCents` / `closingBalanceCents` — the tenant's AVAILABLE
 *     balance just before the period starts and just after it ends;
 *   - `netCents` — closing − opening (the signed change in the tenant's
 *     settlement position over the period);
 *   - `items` — one row per `LedgerCategory` present in the window, carrying the
 *     category's **gross volume** (Σ debit legs) and its posting count.
 *
 * Everything here is pure and side-effect-free — that is what makes it
 * property-testable. Persistence lives in `statements-db.ts` and wraps these
 * helpers. Amounts cross the boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type {
  LedgerAccount,
  LedgerCategory,
  LedgerDirection,
  SettlementStatementStatus,
} from "@/generated/prisma/client";

import { delta } from "./ledger";
import { type Centimes, centimes } from "./money";

export const STATEMENT_STATUSES = ["DRAFT", "FINALIZED", "VOID"] as const;

/** One ledger leg, with the timestamp the statement windows on. */
export interface StatementEntry {
  category: LedgerCategory;
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: Centimes;
  createdAt: Date;
}

/** One itemized category in a statement. */
interface StatementItem {
  category: LedgerCategory;
  /** Gross volume — Σ of the category's DEBIT legs within the window (always ≥ 0). */
  amountCents: Centimes;
  /** Number of postings in this category (each posting has exactly one debit leg). */
  entryCount: number;
}

/** The full outcome of a statement build. */
export interface StatementResult {
  openingBalanceCents: Centimes;
  closingBalanceCents: Centimes;
  /** closing − opening (signed). */
  netCents: Centimes;
  items: StatementItem[];
}

export class StatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementError";
  }
}

/** Allowed outgoing transitions per statement status (terminal states have none). */
const TRANSITIONS: Record<SettlementStatementStatus, readonly SettlementStatementStatus[]> = {
  DRAFT: ["FINALIZED", "VOID"],
  FINALIZED: ["VOID"],
  VOID: [],
};

export function canTransition(
  from: SettlementStatementStatus,
  to: SettlementStatementStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: SettlementStatementStatus,
  to: SettlementStatementStatus,
): void {
  if (!canTransition(from, to)) {
    throw new StatementError(`illegal statement transition ${from} -> ${to}`);
  }
}

/**
 * Aggregate a tenant's ledger legs into a settlement statement.
 *
 * `periodStart` is inclusive and `periodEnd` exclusive. The opening/closing
 * balances are the AVAILABLE account's running balance (`Σ credits − Σ debits`)
 * evaluated against everything before `periodStart` / before `periodEnd`
 * respectively, so `netCents === closing − opening` by construction. The items
 * cover the window's DEBIT legs only (one per posting), grouped by category.
 */
export function buildStatement(
  entries: readonly StatementEntry[],
  periodStart: Date,
  periodEnd: Date,
): StatementResult {
  const start = periodStart.getTime();
  const end = periodEnd.getTime();
  if (start >= end) {
    throw new StatementError("periodStart must be before periodEnd");
  }

  let opening = 0;
  let closing = 0;
  const volumeByCategory = new Map<LedgerCategory, { amountCents: number; count: number }>();

  for (const entry of entries) {
    const t = entry.createdAt.getTime();

    if (entry.account === "AVAILABLE") {
      if (t < start) opening += delta(entry);
      if (t < end) closing += delta(entry);
    }

    if (t >= start && t < end && entry.direction === "DEBIT") {
      const current = volumeByCategory.get(entry.category) ?? { amountCents: 0, count: 0 };
      current.amountCents += entry.amountCents;
      current.count += 1;
      volumeByCategory.set(entry.category, current);
    }
  }

  const items: StatementItem[] = [...volumeByCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, value]) => ({
      category,
      amountCents: centimes(value.amountCents),
      entryCount: value.count,
    }));

  return {
    openingBalanceCents: centimes(opening),
    closingBalanceCents: centimes(closing),
    netCents: centimes(closing - opening),
    items,
  };
}
