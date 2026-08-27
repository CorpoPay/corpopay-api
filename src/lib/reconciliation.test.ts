import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import {
  assertTransition,
  canTransition,
  classifyMatch,
  differenceCents,
  isClean,
  RECONCILIATION_MATCH_STATUSES,
  RECONCILIATION_STATUSES,
  ReconciliationError,
  reconcile,
} from "./reconciliation";

describe("status constants", () => {
  it("lists every reconciliation status exactly once", () => {
    expect(RECONCILIATION_STATUSES).toEqual(["PENDING", "MATCHED", "UNMATCHED", "RESOLVED"]);
    expect(new Set(RECONCILIATION_STATUSES).size).toBe(RECONCILIATION_STATUSES.length);
  });

  it("lists every match status exactly once", () => {
    expect(RECONCILIATION_MATCH_STATUSES).toEqual(["UNMATCHED", "EXACT", "AMOUNT_DIFF"]);
    expect(new Set(RECONCILIATION_MATCH_STATUSES).size).toBe(RECONCILIATION_MATCH_STATUSES.length);
  });
});

describe("canTransition / assertTransition", () => {
  it("allows a pending report to be matched, unmatched, or resolved", () => {
    expect(canTransition("PENDING", "MATCHED")).toBe(true);
    expect(canTransition("PENDING", "UNMATCHED")).toBe(true);
    expect(canTransition("PENDING", "RESOLVED")).toBe(true);
  });

  it("allows re-running between matched and unmatched", () => {
    expect(canTransition("UNMATCHED", "MATCHED")).toBe(true);
    expect(canTransition("MATCHED", "UNMATCHED")).toBe(true);
  });

  it("only allows resolution from matched/unmatched", () => {
    expect(canTransition("MATCHED", "RESOLVED")).toBe(true);
    expect(canTransition("UNMATCHED", "RESOLVED")).toBe(true);
  });

  it("is terminal once resolved", () => {
    for (const next of RECONCILIATION_STATUSES) {
      expect(canTransition("RESOLVED", next)).toBe(false);
    }
  });

  it("throws ReconciliationError for an illegal transition", () => {
    expect(() => assertTransition("RESOLVED", "MATCHED")).toThrow(ReconciliationError);
    expect(() => assertTransition("RESOLVED", "MATCHED")).toThrow(/RESOLVED -> MATCHED/);
  });
});

describe("classifyMatch / differenceCents", () => {
  it("classifies equal amounts as EXACT", () => {
    expect(classifyMatch(centimes(100), centimes(100))).toBe("EXACT");
  });

  it("classifies differing amounts as AMOUNT_DIFF", () => {
    expect(classifyMatch(centimes(100), centimes(99))).toBe("AMOUNT_DIFF");
  });

  it("computes a signed difference (external − internal)", () => {
    expect(differenceCents(centimes(100), centimes(99))).toBe(1);
    expect(differenceCents(centimes(99), centimes(100))).toBe(-1);
  });
});

describe("reconcile", () => {
  it("matches identical lists exactly with no breaks", () => {
    const result = reconcile(
      [{ reference: "a", amountCents: centimes(100) }],
      [{ reference: "a", amountCents: centimes(100) }],
    );
    expect(result.matches).toEqual([
      {
        reference: "a",
        status: "EXACT",
        externalCents: 100,
        internalCents: 100,
        differenceCents: 0,
      },
    ]);
    expect(result.missingInternal).toEqual([]);
    expect(result.missingExternal).toEqual([]);
    expect(result.netDifferenceCents).toBe(0);
    expect(isClean(result)).toBe(true);
  });

  it("flags a centime difference", () => {
    const result = reconcile(
      [{ reference: "a", amountCents: centimes(100) }],
      [{ reference: "a", amountCents: centimes(99) }],
    );
    expect(result.matches[0].status).toBe("AMOUNT_DIFF");
    expect(result.matches[0].differenceCents).toBe(1);
    expect(result.netDifferenceCents).toBe(1);
    expect(isClean(result)).toBe(false);
  });

  it("surfaces external-only and internal-only breaks", () => {
    const result = reconcile(
      [{ reference: "provider-only", amountCents: centimes(500) }],
      [{ reference: "ledger-only", amountCents: centimes(300) }],
    );
    expect(result.missingInternal).toEqual([{ reference: "provider-only", amountCents: 500 }]);
    expect(result.missingExternal).toEqual([{ reference: "ledger-only", amountCents: 300 }]);
    expect(result.netDifferenceCents).toBe(200); // 500 − 300
    expect(isClean(result)).toBe(false);
  });

  it("outputs matches in deterministic reference order", () => {
    const result = reconcile(
      [
        { reference: "b", amountCents: centimes(1) },
        { reference: "a", amountCents: centimes(2) },
      ],
      [
        { reference: "a", amountCents: centimes(2) },
        { reference: "b", amountCents: centimes(1) },
      ],
    );
    expect(result.matches.map((m) => m.reference)).toEqual(["a", "b"]);
  });

  it("aggregates duplicate references on both sides", () => {
    const result = reconcile(
      [
        { reference: "a", amountCents: centimes(60) },
        { reference: "a", amountCents: centimes(40) },
      ],
      [{ reference: "a", amountCents: centimes(100) }],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].status).toBe("EXACT");
    expect(result.netDifferenceCents).toBe(0);
  });

  it("computes the net difference as the sum of every break", () => {
    const result = reconcile(
      [
        { reference: "a", amountCents: centimes(100) }, // matched, exact
        { reference: "b", amountCents: centimes(200) }, // amount diff (internal 150)
        { reference: "c", amountCents: centimes(50) }, // missing internal
      ],
      [
        { reference: "a", amountCents: centimes(100) },
        { reference: "b", amountCents: centimes(150) },
        { reference: "d", amountCents: centimes(30) }, // missing external
      ],
    );
    // external total = 100 + 200 + 50 = 350; internal total = 100 + 150 + 30 = 280
    expect(result.externalTotalCents).toBe(350);
    expect(result.internalTotalCents).toBe(280);
    expect(result.netDifferenceCents).toBe(70);
    // sum of breaks: match diff (50) + missingInternal (50) − missingExternal (30) = 70
    expect(
      result.matches.reduce((sum, m) => sum + m.differenceCents, 0) +
        result.missingInternal.reduce((sum, l) => sum + l.amountCents, 0) -
        result.missingExternal.reduce((sum, l) => sum + l.amountCents, 0),
    ).toBe(70);
  });
});
