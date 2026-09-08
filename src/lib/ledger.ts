/**
 * Double-entry money ledger (PayFac settlement core) — pure, deterministic math.
 *
 * The single source of truth for every minor unit CorpoPay owes or has paid a
 * tenant. All money movement is recorded as a balanced `LedgerPosting` — a
 * debit leg and a credit leg of equal value, in the **same currency** — so the
 * invariant "Σ debits = Σ credits" holds after every write, per currency.
 *
 * Accounts (per tenant):
 *   CASH       — actual money in CorpoPay's pool attributable to the tenant (asset)
 *   PENDING    — captured but not yet settled by the provider (asset)
 *   COLLECTED  — gross customer funds owed to the tenant (liability)
 *   AVAILABLE  — subset of collected eligible for payout (liability)
 *   RESERVE    — held back against reversals (liability)
 *   FEES       — CorpoPay revenue (income)
 *   PAID_OUT   — cumulative amount settled to the tenant (contra-liability)
 *   WALLET     — customer stored-value owed back to the customer (liability)
 *
 * Balance convention: `balanceOf(account) = Σ credits − Σ debits`. Liability and
 * income accounts therefore carry positive ("credit") balances; asset accounts
 * carry negative ("debit") balances. `isBalanced` asserts the global equation
 * Σ debits = Σ credits **within each currency** — money never mixes currencies.
 *
 * Multi-currency (ADR 0006): every leg carries an ISO 4217 `currency`. Balances
 * are computed per (account, currency); `computeBalancesByCurrency` is the
 * authoritative per-currency view, while `computeBalances` is a single-currency
 * projection (defaulting to MAD) kept for backward compatibility.
 *
 * Everything in this module is pure and side-effect-free — that is what makes it
 * property-testable. Persistence (`postEntry`) lives in `ledger-db.ts` and wraps
 * these helpers. Amounts cross the boundary as integer minor units (`Centimes`);
 * the DB stores major units `Decimal(12,2)` — every conversion goes through
 * `money.ts`.
 */
import type { LedgerAccount, LedgerCategory, LedgerDirection } from "@/generated/prisma/client";

import { type Centimes, type Currency, centimes, SUPPORTED_CURRENCIES } from "./money";

export const LEDGER_ACCOUNTS = [
  "CASH",
  "PENDING",
  "COLLECTED",
  "AVAILABLE",
  "RESERVE",
  "FEES",
  "PAID_OUT",
  "WALLET",
] as const;

export const LEDGER_CATEGORIES = [
  "CAPTURE",
  "REFUND",
  "FEE",
  "SPLIT",
  "PAYOUT",
  "CHARGEBACK",
  "RESERVE_RELEASE",
  "ADJUSTMENT",
  "DISBURSEMENT",
] as const;

export interface LedgerLeg {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: Centimes;
  category: LedgerCategory;
  currency: Currency;
  partyId?: string | null;
}

export interface LedgerPosting {
  debit: LedgerLeg;
  credit: LedgerLeg;
  sourceType?: string;
  sourceId?: string;
}

/** Per-currency account balances: `balances[currency][account]`. */
export type LedgerBalances = Record<Currency, Record<LedgerAccount, Centimes>>;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** A debit leg (reduces the account's balance). */
export function debit(
  account: LedgerAccount,
  amountCents: Centimes,
  category: LedgerCategory,
  partyId: string | null = null,
  currency: Currency = "MAD",
): LedgerLeg {
  return {
    account,
    direction: "DEBIT",
    amountCents,
    category,
    currency,
    ...(partyId != null ? { partyId } : {}),
  };
}

/** A credit leg (increases the account's balance). */
export function credit(
  account: LedgerAccount,
  amountCents: Centimes,
  category: LedgerCategory,
  partyId: string | null = null,
  currency: Currency = "MAD",
): LedgerLeg {
  return {
    account,
    direction: "CREDIT",
    amountCents,
    category,
    currency,
    ...(partyId != null ? { partyId } : {}),
  };
}

/** Signed contribution of a leg to its account's balance: credit +, debit −. */
export function delta(leg: Pick<LedgerLeg, "direction" | "amountCents">): Centimes {
  return centimes(leg.direction === "CREDIT" ? leg.amountCents : -leg.amountCents);
}

/** Build a balanced posting, rejecting anything that would unbalance the ledger. */
export function posting(
  debitLeg: LedgerLeg,
  creditLeg: LedgerLeg,
  meta: { sourceType?: string; sourceId?: string } = {},
): LedgerPosting {
  if (debitLeg.direction !== "DEBIT") throw new LedgerError("debit leg must be DEBIT");
  if (creditLeg.direction !== "CREDIT") throw new LedgerError("credit leg must be CREDIT");
  if (debitLeg.currency !== creditLeg.currency) {
    throw new LedgerError(
      `posting must use a single currency (debit ${debitLeg.currency} != credit ${creditLeg.currency})`,
    );
  }
  if (debitLeg.amountCents !== creditLeg.amountCents) {
    throw new LedgerError(
      `posting must balance (debit ${debitLeg.amountCents} != credit ${creditLeg.amountCents})`,
    );
  }
  if (debitLeg.amountCents < 0) throw new LedgerError("amount must be non-negative");
  if (
    debitLeg.account === creditLeg.account &&
    (debitLeg.partyId ?? null) === (creditLeg.partyId ?? null)
  ) {
    throw new LedgerError("debit and credit must differ (account or party)");
  }
  return { debit: debitLeg, credit: creditLeg, ...meta };
}

/** All accounts at a zero balance (single-currency convenience). */
export function zeroBalances(): Record<LedgerAccount, Centimes> {
  return Object.fromEntries(LEDGER_ACCOUNTS.map((account) => [account, centimes(0)])) as Record<
    LedgerAccount,
    Centimes
  >;
}

/** Every supported currency with every account at zero (per-currency convenience). */
function zeroBalancesByCurrency(): LedgerBalances {
  return Object.fromEntries(
    SUPPORTED_CURRENCIES.map((currency) => [currency, zeroBalances()]),
  ) as LedgerBalances;
}

/** Derive per-(account, currency) balances (Σ credits − Σ debits within a currency). */
export function computeBalancesByCurrency(legs: readonly LedgerLeg[]): LedgerBalances {
  const balances = zeroBalancesByCurrency();
  for (const leg of legs) {
    balances[leg.currency][leg.account] = centimes(
      balances[leg.currency][leg.account] + delta(leg),
    );
  }
  return balances;
}

/** Derive one currency's account balances (Σ credits − Σ debits over that currency's legs). */
export function computeBalances(
  legs: readonly LedgerLeg[],
  currency: Currency = "MAD",
): Record<LedgerAccount, Centimes> {
  const balances = zeroBalances();
  for (const leg of legs) {
    if (leg.currency === currency) {
      balances[leg.account] = centimes(balances[leg.account] + delta(leg));
    }
  }
  return balances;
}

/** Balance of a single account in one currency (Σ credits − Σ debits over its legs). */
export function balanceOf(
  legs: readonly LedgerLeg[],
  account: LedgerAccount,
  currency: Currency = "MAD",
): Centimes {
  let balance = 0;
  for (const leg of legs) {
    if (leg.account === account && leg.currency === currency) balance += delta(leg);
  }
  return centimes(balance);
}

/** Per-currency double-entry invariant: Σ debits === Σ credits within each currency. */
export function isBalanced(legs: readonly LedgerLeg[]): boolean {
  const nets = new Map<Currency, number>();
  for (const leg of legs) {
    nets.set(leg.currency, (nets.get(leg.currency) ?? 0) + delta(leg));
  }
  for (const net of nets.values()) if (net !== 0) return false;
  return true;
}

/** Apply a posting to a single-currency account-balance map, returning the new map (pure). */
export function applyPosting(
  balances: Record<LedgerAccount, Centimes>,
  p: LedgerPosting,
): Record<LedgerAccount, Centimes> {
  const next = { ...balances };
  next[p.debit.account] = centimes(next[p.debit.account] + delta(p.debit));
  next[p.credit.account] = centimes(next[p.credit.account] + delta(p.credit));
  return next;
}
