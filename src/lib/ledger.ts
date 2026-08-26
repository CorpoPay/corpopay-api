/**
 * Double-entry money ledger (PayFac settlement core) — pure, deterministic math.
 *
 * The single source of truth for every centime CorpoPay owes or has paid a
 * tenant. All money movement is recorded as a balanced `LedgerPosting` — a
 * debit leg and a credit leg of equal value — so the invariant "Σ debits =
 * Σ credits" holds after every write.
 *
 * Accounts (per tenant):
 *   CASH       — actual money in CorpoPay's pool attributable to the tenant (asset)
 *   PENDING    — captured but not yet settled by the provider (asset)
 *   COLLECTED  — gross customer funds owed to the tenant (liability)
 *   AVAILABLE  — subset of collected eligible for payout (liability)
 *   RESERVE    — held back against reversals (liability)
 *   FEES       — CorpoPay revenue (income)
 *   PAID_OUT   — cumulative amount settled to the tenant (contra-liability)
 *
 * Balance convention: `balanceOf(account) = Σ credits − Σ debits`. Liability and
 * income accounts therefore carry positive ("credit") balances; asset accounts
 * carry negative ("debit") balances. `isBalanced` asserts the global equation
 * Σ debits = Σ credits.
 *
 * Everything in this module is pure and side-effect-free — that is what makes it
 * property-testable. Persistence (`postEntry`) lives in `ledger-db.ts` and wraps
 * these helpers. Amounts cross the boundary as integer centimes (`Centimes`);
 * the DB stores MAD `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { LedgerAccount, LedgerCategory, LedgerDirection } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

export const LEDGER_ACCOUNTS = [
  "CASH",
  "PENDING",
  "COLLECTED",
  "AVAILABLE",
  "RESERVE",
  "FEES",
  "PAID_OUT",
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
}

export interface LedgerPosting {
  debit: LedgerLeg;
  credit: LedgerLeg;
  sourceType?: string;
  sourceId?: string;
}

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
): LedgerLeg {
  return { account, direction: "DEBIT", amountCents, category };
}

/** A credit leg (increases the account's balance). */
export function credit(
  account: LedgerAccount,
  amountCents: Centimes,
  category: LedgerCategory,
): LedgerLeg {
  return { account, direction: "CREDIT", amountCents, category };
}

/** Signed contribution of a leg to its account's balance: credit +, debit −. */
export function delta(leg: LedgerLeg): Centimes {
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
  if (debitLeg.amountCents !== creditLeg.amountCents) {
    throw new LedgerError(
      `posting must balance (debit ${debitLeg.amountCents} != credit ${creditLeg.amountCents})`,
    );
  }
  if (debitLeg.amountCents < 0) throw new LedgerError("amount must be non-negative");
  if (debitLeg.account === creditLeg.account) {
    throw new LedgerError("debit and credit accounts must differ");
  }
  return { debit: debitLeg, credit: creditLeg, ...meta };
}

/** All accounts at a zero balance. */
export function zeroBalances(): Record<LedgerAccount, Centimes> {
  return Object.fromEntries(LEDGER_ACCOUNTS.map((account) => [account, centimes(0)])) as Record<
    LedgerAccount,
    Centimes
  >;
}

/** Derive every account's balance (Σ credits − Σ debits) from a set of legs. */
export function computeBalances(legs: readonly LedgerLeg[]): Record<LedgerAccount, Centimes> {
  const balances = zeroBalances();
  for (const leg of legs) {
    balances[leg.account] = centimes(balances[leg.account] + delta(leg));
  }
  return balances;
}

/** Balance of a single account (Σ credits − Σ debits over its legs). */
export function balanceOf(legs: readonly LedgerLeg[], account: LedgerAccount): Centimes {
  let balance = 0;
  for (const leg of legs) {
    if (leg.account === account) balance += delta(leg);
  }
  return centimes(balance);
}

/** Global double-entry invariant: Σ debits === Σ credits. */
export function isBalanced(legs: readonly LedgerLeg[]): boolean {
  let debits = 0;
  let credits = 0;
  for (const leg of legs) {
    if (leg.direction === "DEBIT") debits += leg.amountCents;
    else credits += leg.amountCents;
  }
  return debits === credits;
}

/** Apply a posting to an account-balance map, returning the new map (pure). */
export function applyPosting(
  balances: Record<LedgerAccount, Centimes>,
  p: LedgerPosting,
): Record<LedgerAccount, Centimes> {
  const next = { ...balances };
  next[p.debit.account] = centimes(next[p.debit.account] + delta(p.debit));
  next[p.credit.account] = centimes(next[p.credit.account] + delta(p.credit));
  return next;
}
