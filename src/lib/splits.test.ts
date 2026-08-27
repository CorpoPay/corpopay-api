import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import {
  assertTransition,
  canTransition,
  computeShares,
  platformShareCents,
  SPLIT_STATUSES,
  SPLIT_TRIGGERS,
  SplitError,
  sourceAccountFor,
  split,
  validateShares,
} from "./splits";

describe("SPLIT_STATUSES", () => {
  it("lists every status exactly once", () => {
    expect(SPLIT_STATUSES).toEqual(["PENDING", "SETTLED", "REVERSED"]);
    expect(new Set(SPLIT_STATUSES).size).toBe(SPLIT_STATUSES.length);
  });
});

describe("SPLIT_TRIGGERS", () => {
  it("lists every trigger exactly once", () => {
    expect(SPLIT_TRIGGERS).toEqual(["AT_CAPTURE", "ON_USAGE", "MANUAL"]);
    expect(new Set(SPLIT_TRIGGERS).size).toBe(SPLIT_TRIGGERS.length);
  });
});

describe("canTransition / assertTransition", () => {
  it("allows a held split to settle or reverse", () => {
    expect(canTransition("PENDING", "SETTLED")).toBe(true);
    expect(canTransition("PENDING", "REVERSED")).toBe(true);
    expect(() => assertTransition("PENDING", "SETTLED")).not.toThrow();
  });

  it("has no outgoing transitions from terminal states", () => {
    for (const terminal of ["SETTLED", "REVERSED"] as const) {
      for (const next of SPLIT_STATUSES) {
        expect(canTransition(terminal, next)).toBe(false);
      }
    }
  });

  it("throws SplitError for an illegal transition", () => {
    expect(() => assertTransition("SETTLED", "REVERSED")).toThrow(SplitError);
    expect(() => assertTransition("SETTLED", "REVERSED")).toThrow(/SETTLED -> REVERSED/);
  });
});

describe("sourceAccountFor", () => {
  it("debits COLLECTED for an at-capture split", () => {
    expect(sourceAccountFor("AT_CAPTURE")).toBe("COLLECTED");
  });

  it("debits AVAILABLE for on-usage / manual splits", () => {
    expect(sourceAccountFor("ON_USAGE")).toBe("AVAILABLE");
    expect(sourceAccountFor("MANUAL")).toBe("AVAILABLE");
  });
});

describe("validateShares", () => {
  it("accepts a valid share list", () => {
    expect(() =>
      validateShares([
        { partyId: "p1", shareBps: 8000 },
        { partyId: "p2", shareBps: 2000 },
      ]),
    ).not.toThrow();
  });

  it("rejects an empty share list", () => {
    expect(() => validateShares([])).toThrow(SplitError);
  });

  it("rejects non-positive or over-10000 shareBps", () => {
    expect(() => validateShares([{ partyId: "p1", shareBps: 0 }])).toThrow(SplitError);
    expect(() => validateShares([{ partyId: "p1", shareBps: 10_001 }])).toThrow(SplitError);
    expect(() => validateShares([{ partyId: "p1", shareBps: 1.5 }])).toThrow(SplitError);
  });

  it("rejects shares that sum to more than 10000 bps", () => {
    expect(() =>
      validateShares([
        { partyId: "p1", shareBps: 6000 },
        { partyId: "p2", shareBps: 5000 },
      ]),
    ).toThrow(SplitError);
  });
});

describe("computeShares", () => {
  it("divides a total exactly with largest-remainder", () => {
    const allocations = computeShares(centimes(100), [
      { partyId: "p1", shareBps: 3333 },
      { partyId: "p2", shareBps: 3333 },
      { partyId: "p3", shareBps: 3334 },
    ]);
    expect(allocations).toEqual([
      { partyId: "p1", amountCents: 33 },
      { partyId: "p2", amountCents: 33 },
      { partyId: "p3", amountCents: 34 },
    ]);
  });

  it("never loses or creates a centime", () => {
    const allocations = computeShares(centimes(9999), [
      { partyId: "p1", shareBps: 5000 },
      { partyId: "p2", shareBps: 3000 },
      { partyId: "p3", shareBps: 2000 },
    ]);
    expect(allocations.reduce((sum, a) => sum + a.amountCents, 0)).toBe(9999);
  });
});

describe("split", () => {
  it("returns beneficiary shares plus the platform remainder", () => {
    const result = split(centimes(10_000), [{ partyId: "host", shareBps: 8000 }]);
    expect(result.shares).toEqual([{ partyId: "host", amountCents: 8000 }]);
    expect(result.platformCents).toBe(2000);
  });

  it("rounds the odd centime without breaking the total", () => {
    const result = split(centimes(3), [{ partyId: "p1", shareBps: 5000 }]);
    expect(result.shares[0].amountCents + result.platformCents).toBe(3);
  });

  it("platform gets everything when the beneficiary share is 0 bps… (rejected)", () => {
    expect(() => split(centimes(100), [{ partyId: "p1", shareBps: 0 }])).toThrow(SplitError);
  });
});

describe("platformShareCents", () => {
  it("subtracts the beneficiary total from the source", () => {
    expect(
      platformShareCents(centimes(10_000), [{ partyId: "p1", amountCents: centimes(8000) }]),
    ).toBe(2000);
  });
});
