import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { isClean, reconcile } from "./reconciliation";

/**
 * Property tests for the reconciliation matcher.
 *
 * Invariants that make the three-way match safe to close a settlement period:
 *   - the net difference always equals `externalTotal − internalTotal`;
 *   - the net difference also equals the sum of every break (match differences
 *     + provider-only amounts − ledger-only amounts);
 *   - a match is EXACT iff both sides agree to the centime;
 *   - an identical pair reconciles clean (no breaks, net difference 0);
 *   - duplicate references aggregate to the same total (no centime lost).
 */

const reference = fc.oneof(
  fc.constantFrom("a", "b", "c"),
  fc.string({ minLength: 1, maxLength: 4 }),
);
const amountCents = fc.integer({ min: 0, max: 1_000_000 }).map(centimes);
const line = fc.record({ reference, amountCents });
const lines = fc.array(line, { minLength: 0, maxLength: 30 });

describe("reconcile properties", () => {
  it("net difference equals externalTotal − internalTotal", () => {
    fc.assert(
      fc.property(lines, lines, (external, internal) => {
        const result = reconcile(external, internal);
        expect(result.netDifferenceCents).toBe(
          result.externalTotalCents - result.internalTotalCents,
        );
      }),
    );
  });

  it("net difference equals the sum of every break", () => {
    fc.assert(
      fc.property(lines, lines, (external, internal) => {
        const result = reconcile(external, internal);
        const breakSum =
          result.matches.reduce((sum, m) => sum + m.differenceCents, 0) +
          result.missingInternal.reduce((sum, l) => sum + l.amountCents, 0) -
          result.missingExternal.reduce((sum, l) => sum + l.amountCents, 0);
        expect(result.netDifferenceCents).toBe(breakSum);
      }),
    );
  });

  it("a match is EXACT iff the amounts agree", () => {
    fc.assert(
      fc.property(lines, lines, (external, internal) => {
        const result = reconcile(external, internal);
        for (const match of result.matches) {
          expect(match.status === "EXACT").toBe(match.externalCents === match.internalCents);
        }
      }),
    );
  });

  it("every reference is classified exactly once", () => {
    fc.assert(
      fc.property(lines, lines, (external, internal) => {
        const result = reconcile(external, internal);
        const externalRefs = new Set(external.map((l) => l.reference));
        const internalRefs = new Set(internal.map((l) => l.reference));
        const uniqueRefs = new Set([...externalRefs, ...internalRefs]);
        const classified =
          result.matches.length + result.missingInternal.length + result.missingExternal.length;
        expect(classified).toBe(uniqueRefs.size);
      }),
    );
  });

  it("an identical pair reconciles clean with a zero net difference", () => {
    fc.assert(
      fc.property(lines, (input) => {
        const result = reconcile(input, input);
        expect(isClean(result)).toBe(true);
        expect(result.netDifferenceCents).toBe(0);
        expect(result.matches.every((m) => m.status === "EXACT")).toBe(true);
      }),
    );
  });

  it("duplicate references aggregate without losing a centime", () => {
    fc.assert(
      fc.property(lines, lines, (external, internal) => {
        const extTotal = external.reduce((s, l) => s + l.amountCents, 0);
        const intTotal = internal.reduce((s, l) => s + l.amountCents, 0);
        const result = reconcile(external, internal);
        expect(result.externalTotalCents).toBe(extTotal);
        expect(result.internalTotalCents).toBe(intTotal);
      }),
    );
  });
});
