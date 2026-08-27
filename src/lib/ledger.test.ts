import { describe, expect, it } from "vitest";

import {
  applyPosting,
  balanceOf,
  computeBalances,
  credit,
  debit,
  delta,
  isBalanced,
  LEDGER_ACCOUNTS,
  LedgerError,
  posting,
  zeroBalances,
} from "./ledger";
import { centimes } from "./money";

describe("debit / credit / delta", () => {
  it("builds a debit leg", () => {
    expect(debit("CASH", centimes(1000), "CAPTURE")).toEqual({
      account: "CASH",
      direction: "DEBIT",
      amountCents: 1000,
      category: "CAPTURE",
    });
  });

  it("builds a credit leg", () => {
    expect(credit("COLLECTED", centimes(1000), "CAPTURE")).toEqual({
      account: "COLLECTED",
      direction: "CREDIT",
      amountCents: 1000,
      category: "CAPTURE",
    });
  });

  it("delta is positive for credit, negative for debit", () => {
    expect(delta(credit("COLLECTED", centimes(500), "CAPTURE"))).toBe(500);
    expect(delta(debit("CASH", centimes(500), "CAPTURE"))).toBe(-500);
  });
});

describe("posting", () => {
  const d = debit("CASH", centimes(1000), "CAPTURE");
  const c = credit("COLLECTED", centimes(1000), "CAPTURE");

  it("returns a balanced posting", () => {
    expect(posting(d, c)).toEqual({ debit: d, credit: c });
  });

  it("rejects a debit leg that is not DEBIT", () => {
    expect(() => posting(c, c)).toThrow(LedgerError);
    expect(() => posting(c, c)).toThrow("debit leg must be DEBIT");
  });

  it("rejects a credit leg that is not CREDIT", () => {
    expect(() => posting(d, d)).toThrow(LedgerError);
    expect(() => posting(d, d)).toThrow("credit leg must be CREDIT");
  });

  it("rejects an unbalanced posting", () => {
    const bigger = credit("COLLECTED", centimes(2000), "CAPTURE");
    expect(() => posting(d, bigger)).toThrow("posting must balance");
  });

  it("rejects a negative amount", () => {
    expect(() =>
      posting(debit("CASH", centimes(-1), "CAPTURE"), credit("COLLECTED", centimes(-1), "CAPTURE")),
    ).toThrow("amount must be non-negative");
  });

  it("rejects same-account legs", () => {
    expect(() =>
      posting(debit("CASH", centimes(1000), "CAPTURE"), credit("CASH", centimes(1000), "CAPTURE")),
    ).toThrow("debit and credit must differ (account or party)");
  });

  it("allows same-account legs between different parties", () => {
    expect(() =>
      posting(
        debit("AVAILABLE", centimes(1000), "SPLIT"),
        credit("AVAILABLE", centimes(1000), "SPLIT", "party-1"),
      ),
    ).not.toThrow();
  });
});

describe("balances", () => {
  const capture = posting(
    debit("CASH", centimes(1000), "CAPTURE"),
    credit("COLLECTED", centimes(1000), "CAPTURE"),
  );
  const fee = posting(
    debit("COLLECTED", centimes(100), "FEE"),
    credit("FEES", centimes(100), "FEE"),
  );

  it("zeroBalances returns every account at zero", () => {
    const zeros = zeroBalances();
    expect(Object.keys(zeros).sort()).toEqual([...LEDGER_ACCOUNTS].sort());
    for (const value of Object.values(zeros)) expect(value).toBe(0);
  });

  it("computeBalances derives credit-minus-debit per account", () => {
    const legs = [capture.debit, capture.credit, fee.debit, fee.credit];
    const balances = computeBalances(legs);
    expect(balances.CASH).toBe(-1000);
    expect(balances.COLLECTED).toBe(900);
    expect(balances.FEES).toBe(100);
    expect(balances.AVAILABLE).toBe(0);
  });

  it("balanceOf returns a single account's balance", () => {
    const legs = [capture.debit, capture.credit, fee.debit, fee.credit];
    expect(balanceOf(legs, "COLLECTED")).toBe(900);
    expect(balanceOf(legs, "CASH")).toBe(-1000);
    expect(balanceOf(legs, "AVAILABLE")).toBe(0);
  });

  it("isBalanced detects the global double-entry invariant", () => {
    expect(isBalanced([capture.debit, capture.credit])).toBe(true);
    expect(isBalanced([capture.debit])).toBe(false);
  });

  it("applyPosting mutates a copy, not the input", () => {
    const before = zeroBalances();
    const after = applyPosting(before, capture);
    expect(before.CASH).toBe(0);
    expect(after.CASH).toBe(-1000);
    expect(after.COLLECTED).toBe(1000);
  });
});
