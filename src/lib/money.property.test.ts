import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  centimes,
  centimesToMad,
  centimesToMadString,
  fromMinor,
  madToCentimes,
  SUPPORTED_CURRENCIES,
  toMinor,
} from "./money";

/**
 * Property-based tests for the money conversion helpers.
 *
 * For a payments system the invariant that matters most is that no minor unit is
 * ever lost or invented: every conversion is reversible and integral. `fast-check`
 * asserts these over thousands of random cases instead of a handful of hand-picked
 * examples, which is exactly where floating-point bugs hide.
 */
describe("money properties", () => {
  it("madToCentimes always yields a whole integer (no fractional centimes)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1_000_000, noNaN: true }), (amount) => {
        expect(Number.isInteger(madToCentimes(amount))).toBe(true);
      }),
    );
  });

  it("centimesToMad divides exactly by 100", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (c) => {
        expect(centimesToMad(centimes(c))).toBe(c / 100);
      }),
    );
  });

  it("round-trips MAD → centimes → MAD within one centime", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1_000_000, noNaN: true }), (amount) => {
        const back = centimesToMad(madToCentimes(amount));
        expect(Math.abs(back - amount)).toBeLessThanOrEqual(0.01);
      }),
    );
  });

  it("centimesToMadString always has exactly two decimals and round-trips", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (c) => {
        const s = centimesToMadString(centimes(c));
        expect(s).toMatch(/^\d+\.\d{2}$/);
        expect(Number(s)).toBe(c / 100);
      }),
    );
  });
});

describe("multi-currency money properties", () => {
  it("toMinor always yields a whole integer for every supported currency", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_CURRENCIES),
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        (currency, amount) => {
          expect(Number.isInteger(toMinor(amount, currency))).toBe(true);
        },
      ),
    );
  });

  it("toMinor/fromMinor round-trip minor → major → minor exactly", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_CURRENCIES),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (currency, minor) => {
          expect(toMinor(fromMinor(centimes(minor), currency), currency)).toBe(minor);
        },
      ),
    );
  });
});
