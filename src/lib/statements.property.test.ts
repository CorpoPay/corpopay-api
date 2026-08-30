import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { buildStatement, type StatementEntry } from "./statements";

/**
 * Property tests for the settlement statement builder.
 *
 * Invariants that make a statement safe to invoice from:
 *   - `netCents` always equals `closing − opening` (the AVAILABLE change);
 *   - the itemized gross volume sums to the window's total DEBIT volume;
 *   - `entryCount` sums to the window's total DEBIT-leg count;
 *   - output is deterministic and items are ordered by category.
 */

const CATEGORIES = [
  "CAPTURE",
  "FEE",
  "REFUND",
  "PAYOUT",
  "SPLIT",
  "CHARGEBACK",
  "RESERVE_RELEASE",
  "ADJUSTMENT",
  "DISBURSEMENT",
] as const;
const ACCOUNTS = [
  "CASH",
  "PENDING",
  "COLLECTED",
  "AVAILABLE",
  "RESERVE",
  "FEES",
  "PAID_OUT",
] as const;

const entryArb: fc.Arbitrary<StatementEntry> = fc.record({
  category: fc.constantFrom(...CATEGORIES),
  account: fc.constantFrom(...ACCOUNTS),
  direction: fc.constantFrom("DEBIT" as const, "CREDIT" as const),
  amountCents: fc.integer({ min: 0, max: 1_000_000 }).map(centimes),
  createdAt: fc.date({ min: new Date(0), max: new Date(10_000) }),
});
const entriesArb = fc.array(entryArb, { minLength: 0, maxLength: 40 });
const periodArb = fc.tuple(
  fc.integer({ min: 0, max: 5_000 }),
  fc.integer({ min: 5_001, max: 10_000 }),
);

describe("buildStatement properties", () => {
  it("netCents equals closing − opening", () => {
    fc.assert(
      fc.property(entriesArb, periodArb, (entries, [start, end]) => {
        const result = buildStatement(entries, new Date(start), new Date(end));
        expect(result.netCents).toBe(result.closingBalanceCents - result.openingBalanceCents);
      }),
    );
  });

  it("itemized volume sums to the window's total DEBIT volume", () => {
    fc.assert(
      fc.property(entriesArb, periodArb, (entries, [start, end]) => {
        const result = buildStatement(entries, new Date(start), new Date(end));
        const inWindow = entries.filter(
          (e) => e.createdAt.getTime() >= start && e.createdAt.getTime() < end,
        );
        const debitVolume = inWindow
          .filter((e) => e.direction === "DEBIT")
          .reduce((sum, e) => sum + e.amountCents, 0);
        const itemVolume = result.items.reduce((sum, i) => sum + i.amountCents, 0);
        expect(itemVolume).toBe(debitVolume);
      }),
    );
  });

  it("entryCount sums to the window's DEBIT-leg count", () => {
    fc.assert(
      fc.property(entriesArb, periodArb, (entries, [start, end]) => {
        const result = buildStatement(entries, new Date(start), new Date(end));
        const debitCount = entries.filter(
          (e) =>
            e.direction === "DEBIT" &&
            e.createdAt.getTime() >= start &&
            e.createdAt.getTime() < end,
        ).length;
        const itemCount = result.items.reduce((sum, i) => sum + i.entryCount, 0);
        expect(itemCount).toBe(debitCount);
      }),
    );
  });

  it("items are ordered by category (deterministic)", () => {
    fc.assert(
      fc.property(entriesArb, periodArb, (entries, [start, end]) => {
        const a = buildStatement(entries, new Date(start), new Date(end));
        const b = buildStatement(entries, new Date(start), new Date(end));
        expect(a.items).toEqual(b.items);
        const categories = a.items.map((i) => i.category);
        expect([...categories].sort()).toEqual(categories);
      }),
    );
  });
});
