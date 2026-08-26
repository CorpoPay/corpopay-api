import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import {
  assertTransition,
  canTransition,
  eligibleAmount,
  meetsThreshold,
  PAYOUT_STATUSES,
  PayoutError,
} from "./payout";

describe("PAYOUT_STATUSES", () => {
  it("lists every status exactly once", () => {
    expect(PAYOUT_STATUSES).toEqual([
      "DRAFT",
      "SCHEDULED",
      "PENDING",
      "PROCESSING",
      "PAID",
      "FAILED",
      "CANCELLED",
    ]);
    expect(new Set(PAYOUT_STATUSES).size).toBe(PAYOUT_STATUSES.length);
  });
});

describe("canTransition", () => {
  it("allows the documented forward + cancel edges", () => {
    expect(canTransition("DRAFT", "SCHEDULED")).toBe(true);
    expect(canTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(canTransition("SCHEDULED", "PENDING")).toBe(true);
    expect(canTransition("PENDING", "PROCESSING")).toBe(true);
    expect(canTransition("PROCESSING", "PAID")).toBe(true);
    expect(canTransition("PROCESSING", "FAILED")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
  });

  it("rejects skipping or reversing the forward path", () => {
    expect(canTransition("DRAFT", "PAID")).toBe(false);
    expect(canTransition("DRAFT", "FAILED")).toBe(false);
    expect(canTransition("PENDING", "PAID")).toBe(false);
    expect(canTransition("PROCESSING", "DRAFT")).toBe(false);
    expect(canTransition("PAID", "FAILED")).toBe(false);
  });

  it("has no outgoing transitions from terminal states", () => {
    for (const terminal of ["PAID", "FAILED", "CANCELLED"] as const) {
      for (const next of PAYOUT_STATUSES) {
        expect(canTransition(terminal, next)).toBe(false);
      }
    }
  });
});

describe("assertTransition", () => {
  it("does not throw for a legal transition", () => {
    expect(() => assertTransition("DRAFT", "SCHEDULED")).not.toThrow();
  });

  it("throws PayoutError for an illegal transition", () => {
    expect(() => assertTransition("DRAFT", "PAID")).toThrow(PayoutError);
    expect(() => assertTransition("DRAFT", "PAID")).toThrow(/DRAFT -> PAID/);
  });
});

describe("eligibleAmount", () => {
  it("subtracts already-scheduled funds", () => {
    expect(eligibleAmount(centimes(100000), centimes(25000))).toBe(75000);
  });

  it("floors at zero when scheduled exceeds available", () => {
    expect(eligibleAmount(centimes(10000), centimes(25000))).toBe(0);
  });

  it("returns the full balance when nothing is scheduled", () => {
    expect(eligibleAmount(centimes(12345), centimes(0))).toBe(12345);
  });
});

describe("meetsThreshold", () => {
  it("pays whenever anything is available when no threshold is set", () => {
    expect(meetsThreshold(centimes(1), null)).toBe(true);
    expect(meetsThreshold(centimes(0), null)).toBe(false);
  });

  it("requires the threshold to be reached when one is set", () => {
    expect(meetsThreshold(centimes(10000), centimes(10000))).toBe(true);
    expect(meetsThreshold(centimes(10000), centimes(10001))).toBe(false);
    expect(meetsThreshold(centimes(20000), centimes(10000))).toBe(true);
  });
});
