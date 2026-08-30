import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import {
  assertTransition,
  buildStatement,
  canTransition,
  STATEMENT_STATUSES,
  type StatementEntry,
  StatementError,
} from "./statements";

const T0 = new Date("2026-01-01T00:00:00Z");
const START = new Date("2026-02-01T00:00:00Z");
const END = new Date("2026-03-01T00:00:00Z");
const MID = new Date("2026-02-15T00:00:00Z");

function entry(overrides: Partial<StatementEntry> = {}): StatementEntry {
  return {
    category: "CAPTURE",
    account: "AVAILABLE",
    direction: "DEBIT",
    amountCents: centimes(0),
    createdAt: MID,
    ...overrides,
  };
}

describe("STATEMENT_STATUSES", () => {
  it("lists every status exactly once", () => {
    expect(STATEMENT_STATUSES).toEqual(["DRAFT", "FINALIZED", "VOID"]);
    expect(new Set(STATEMENT_STATUSES).size).toBe(STATEMENT_STATUSES.length);
  });
});

describe("canTransition / assertTransition", () => {
  it("allows draft → finalized / void", () => {
    expect(canTransition("DRAFT", "FINALIZED")).toBe(true);
    expect(canTransition("DRAFT", "VOID")).toBe(true);
  });

  it("allows finalized → void", () => {
    expect(canTransition("FINALIZED", "VOID")).toBe(true);
  });

  it("is terminal once voided", () => {
    for (const next of STATEMENT_STATUSES) {
      expect(canTransition("VOID", next)).toBe(false);
    }
  });

  it("throws StatementError for an illegal transition", () => {
    expect(() => assertTransition("FINALIZED", "DRAFT")).toThrow(StatementError);
    expect(() => assertTransition("FINALIZED", "DRAFT")).toThrow(/FINALIZED -> DRAFT/);
  });
});

describe("buildStatement", () => {
  it("returns an empty statement for no entries", () => {
    const result = buildStatement([], START, END);
    expect(result).toEqual({
      openingBalanceCents: 0,
      closingBalanceCents: 0,
      netCents: 0,
      items: [],
    });
  });

  it("computes opening/closing AVAILABLE balance and the net", () => {
    const result = buildStatement(
      [
        entry({
          createdAt: T0,
          account: "AVAILABLE",
          direction: "CREDIT",
          amountCents: centimes(1000),
        }),
        entry({ account: "AVAILABLE", direction: "CREDIT", amountCents: centimes(500) }),
      ],
      START,
      END,
    );
    expect(result.openingBalanceCents).toBe(1000);
    expect(result.closingBalanceCents).toBe(1500);
    expect(result.netCents).toBe(500);
  });

  it("ignores AVAILABLE movements outside the window for the balance", () => {
    const result = buildStatement(
      [
        entry({
          createdAt: new Date("2026-04-01T00:00:00Z"),
          account: "AVAILABLE",
          direction: "CREDIT",
          amountCents: centimes(999),
        }),
      ],
      START,
      END,
    );
    expect(result.openingBalanceCents).toBe(0);
    expect(result.closingBalanceCents).toBe(0);
    expect(result.netCents).toBe(0);
  });

  it("itemizes category gross volume from DEBIT legs only", () => {
    const result = buildStatement(
      [
        entry({
          category: "CAPTURE",
          account: "CASH",
          direction: "DEBIT",
          amountCents: centimes(1000),
        }),
        entry({
          category: "CAPTURE",
          account: "COLLECTED",
          direction: "CREDIT",
          amountCents: centimes(1000),
        }),
        entry({
          category: "FEE",
          account: "COLLECTED",
          direction: "DEBIT",
          amountCents: centimes(29),
        }),
        entry({ category: "FEE", account: "FEES", direction: "CREDIT", amountCents: centimes(29) }),
      ],
      START,
      END,
    );
    expect(result.items).toEqual([
      { category: "CAPTURE", amountCents: 1000, entryCount: 1 },
      { category: "FEE", amountCents: 29, entryCount: 1 },
    ]);
  });

  it("does not count DEBIT legs outside the window", () => {
    const result = buildStatement(
      [entry({ createdAt: T0, account: "CASH", direction: "DEBIT", amountCents: centimes(50) })],
      START,
      END,
    );
    expect(result.items).toEqual([]);
  });

  it("sorts items by category", () => {
    const result = buildStatement(
      [
        entry({
          category: "PAYOUT",
          account: "AVAILABLE",
          direction: "DEBIT",
          amountCents: centimes(1),
        }),
        entry({
          category: "CAPTURE",
          account: "CASH",
          direction: "DEBIT",
          amountCents: centimes(1),
        }),
      ],
      START,
      END,
    );
    expect(result.items.map((i) => i.category)).toEqual(["CAPTURE", "PAYOUT"]);
  });

  it("rejects a period where start is not before end", () => {
    expect(() => buildStatement([], END, START)).toThrow(StatementError);
    expect(() => buildStatement([], START, START)).toThrow(StatementError);
  });
});
