import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import {
  assertTransition,
  canTransition,
  coveredAmount,
  DISPUTE_STATUSES,
  fundReversal,
  ReversalError,
} from "./reversals";

function policy(reversalFunding: string, allowNegative = false) {
  return { reversalFunding, allowNegative } as {
    reversalFunding: "NET_FROM_AVAILABLE" | "DEBIT_RESERVE" | "INVOICE_TENANT" | "ALLOW_NEGATIVE";
    allowNegative: boolean;
  };
}

describe("DISPUTE_STATUSES", () => {
  it("lists every status exactly once", () => {
    expect(DISPUTE_STATUSES).toEqual(["OPEN", "WON", "LOST"]);
    expect(new Set(DISPUTE_STATUSES).size).toBe(DISPUTE_STATUSES.length);
  });
});

describe("canTransition / assertTransition", () => {
  it("allows OPEN → WON and OPEN → LOST", () => {
    expect(canTransition("OPEN", "WON")).toBe(true);
    expect(canTransition("OPEN", "LOST")).toBe(true);
  });

  it("rejects anything from a terminal state", () => {
    for (const terminal of ["WON", "LOST"] as const) {
      for (const next of DISPUTE_STATUSES) {
        expect(canTransition(terminal, next)).toBe(false);
      }
    }
    expect(canTransition("OPEN", "OPEN")).toBe(false);
  });

  it("assertTransition throws ReversalError on illegal moves", () => {
    expect(() => assertTransition("WON", "LOST")).toThrow(ReversalError);
    expect(() => assertTransition("OPEN", "WON")).not.toThrow();
  });
});

describe("fundReversal", () => {
  it("NET_FROM_AVAILABLE draws from available, then leaves the shortfall uncovered", () => {
    expect(
      fundReversal(policy("NET_FROM_AVAILABLE"), centimes(10000), centimes(40000), centimes(0)),
    ).toEqual({
      fromAvailable: centimes(10000),
      fromReserve: centimes(0),
      uncovered: centimes(0),
    });
    expect(
      fundReversal(policy("NET_FROM_AVAILABLE"), centimes(40000), centimes(10000), centimes(0)),
    ).toEqual({
      fromAvailable: centimes(10000),
      fromReserve: centimes(0),
      uncovered: centimes(30000),
    });
  });

  it("DEBIT_RESERVE draws reserve first, then available, then uncovered", () => {
    // Reserve covers it all.
    expect(
      fundReversal(policy("DEBIT_RESERVE"), centimes(10000), centimes(5000), centimes(20000)),
    ).toEqual({
      fromAvailable: centimes(0),
      fromReserve: centimes(10000),
      uncovered: centimes(0),
    });
    // Reserve partially covers, available covers the rest.
    expect(
      fundReversal(policy("DEBIT_RESERVE"), centimes(10000), centimes(6000), centimes(4000)),
    ).toEqual({
      fromAvailable: centimes(6000),
      fromReserve: centimes(4000),
      uncovered: centimes(0),
    });
    // Neither fully covers.
    expect(
      fundReversal(policy("DEBIT_RESERVE"), centimes(20000), centimes(3000), centimes(4000)),
    ).toEqual({
      fromAvailable: centimes(3000),
      fromReserve: centimes(4000),
      uncovered: centimes(13000),
    });
  });

  it("INVOICE_TENANT never touches ledger balances", () => {
    expect(
      fundReversal(policy("INVOICE_TENANT"), centimes(10000), centimes(999999), centimes(999999)),
    ).toEqual({
      fromAvailable: centimes(0),
      fromReserve: centimes(0),
      uncovered: centimes(10000),
    });
  });

  it("ALLOW_NEGATIVE debits the full gross from available", () => {
    expect(
      fundReversal(policy("ALLOW_NEGATIVE", true), centimes(10000), centimes(0), centimes(0)),
    ).toEqual({
      fromAvailable: centimes(10000),
      fromReserve: centimes(0),
      uncovered: centimes(0),
    });
  });

  it("rejects negative inputs", () => {
    expect(() =>
      fundReversal(policy("NET_FROM_AVAILABLE"), centimes(-1), centimes(0), centimes(0)),
    ).toThrow(ReversalError);
    expect(() =>
      fundReversal(policy("NET_FROM_AVAILABLE"), centimes(0), centimes(-1), centimes(0)),
    ).toThrow(ReversalError);
    expect(() =>
      fundReversal(policy("DEBIT_RESERVE"), centimes(0), centimes(0), centimes(-1)),
    ).toThrow(ReversalError);
  });
});

describe("coveredAmount", () => {
  it("sums the immediately-recovered legs", () => {
    expect(
      coveredAmount({
        fromAvailable: centimes(3000),
        fromReserve: centimes(4000),
        uncovered: centimes(13000),
      }),
    ).toBe(7000);
  });
});
