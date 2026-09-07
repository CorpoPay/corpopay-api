import { describe, expect, it } from "vitest";

import {
  FINANCE_CAPABILITIES,
  FINANCE_PRESETS,
  type FinanceConfigValidationCode,
  type FinanceConfigViolation,
  type FinancePreset,
  presetCapabilities,
  validateFinanceCapabilities,
} from "./finance-config";

const codesOf = (violations: FinanceConfigViolation[]): FinanceConfigValidationCode[] =>
  violations.map((v) => v.code);

describe("finance capability list", () => {
  it("has no duplicates", () => {
    expect(new Set(FINANCE_CAPABILITIES).size).toBe(FINANCE_CAPABILITIES.length);
  });

  it("is referenced by every preset (no preset typos)", () => {
    for (const preset of Object.keys(FINANCE_PRESETS) as FinancePreset[]) {
      for (const cap of presetCapabilities(preset)) {
        expect(FINANCE_CAPABILITIES).toContain(cap);
      }
    }
  });
});

describe("validateFinanceCapabilities", () => {
  it("accepts the empty config (tenant disabled)", () => {
    expect(validateFinanceCapabilities([])).toEqual([]);
  });

  it("accepts a single capture method", () => {
    expect(validateFinanceCapabilities(["INSTANT_CAPTURE"])).toEqual([]);
  });

  it("accepts the wallet-only model (OtoParking, with card top-up)", () => {
    expect(validateFinanceCapabilities(["WALLET", "INSTANT_CAPTURE"])).toEqual([]);
  });

  it("accepts every preset", () => {
    for (const preset of Object.keys(FINANCE_PRESETS) as FinancePreset[]) {
      expect(validateFinanceCapabilities(presetCapabilities(preset))).toEqual([]);
    }
  });

  it("rejects an unknown capability", () => {
    const violations = validateFinanceCapabilities(["INSTANT_CAPTURE", "TELEPORTATION"]);
    expect(codesOf(violations)).toEqual(["UNKNOWN_CAPABILITY"]);
  });

  it("rejects a duplicate capability", () => {
    const violations = validateFinanceCapabilities(["WALLET", "WALLET"]);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_CAPABILITY", capability: "WALLET" }),
    );
  });

  it("rejects SUBSCRIPTIONS without a capture method", () => {
    const violations = validateFinanceCapabilities(["WALLET", "SUBSCRIPTIONS"]);
    expect(violations).toContainEqual(
      expect.objectContaining({
        code: "REQUIRES_CAPTURE_FUNDING",
        capability: "SUBSCRIPTIONS",
      }),
    );
  });

  it("rejects INSTALLMENTS without a capture method", () => {
    const violations = validateFinanceCapabilities(["INSTALLMENTS"]);
    expect(violations).toContainEqual(
      expect.objectContaining({
        code: "REQUIRES_CAPTURE_FUNDING",
        capability: "INSTALLMENTS",
      }),
    );
  });

  it("rejects MARKETPLACE_SPLITS without a capture method", () => {
    const violations = validateFinanceCapabilities(["WALLET", "MARKETPLACE_SPLITS"]);
    expect(violations).toContainEqual(
      expect.objectContaining({
        code: "REQUIRES_CAPTURE_FUNDING",
        capability: "MARKETPLACE_SPLITS",
      }),
    );
  });

  it("accepts capture-dependent features when a capture method is enabled", () => {
    const caps = ["INSTANT_CAPTURE", "SUBSCRIPTIONS", "INSTALLMENTS", "MARKETPLACE_SPLITS"];
    expect(validateFinanceCapabilities(caps)).toEqual([]);
  });

  it("reports multiple violations at once", () => {
    const violations = validateFinanceCapabilities([
      "SUBSCRIPTIONS",
      "MARKETPLACE_SPLITS",
      "WALLET",
      "WALLET",
      "NONSENSE",
    ]);
    const codes = codesOf(violations);
    expect(codes.filter((c) => c === "REQUIRES_CAPTURE_FUNDING")).toHaveLength(2);
    expect(codes.filter((c) => c === "DUPLICATE_CAPABILITY")).toHaveLength(1);
    expect(codes.filter((c) => c === "UNKNOWN_CAPABILITY")).toHaveLength(1);
  });
});
