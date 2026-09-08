import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { convertMinor, crossRate, FX_BASE_RATES, formatRate } from "./fx";
import { type Currency, centimes, SUPPORTED_CURRENCIES } from "./money";

const currency = fc.constantFrom(...SUPPORTED_CURRENCIES);

describe("fx properties", () => {
  it("convertMinor always yields a whole integer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.double({ min: 0.0001, max: 100, noNaN: true }),
        (minor, rate) => {
          expect(Number.isInteger(convertMinor(centimes(minor), rate))).toBe(true);
        },
      ),
    );
  });

  it("crossRate is antisymmetric across every supported pair", () => {
    fc.assert(
      fc.property(currency, currency, (a: Currency, b: Currency) => {
        if (a === b) {
          expect(crossRate(a, b, FX_BASE_RATES)).toBe(1);
          return;
        }
        expect(crossRate(a, b, FX_BASE_RATES) * crossRate(b, a, FX_BASE_RATES)).toBeCloseTo(1, 6);
      }),
    );
  });

  it("crossRate is transitive via the MAD anchor", () => {
    fc.assert(
      fc.property(currency, currency, currency, (a: Currency, b: Currency, c: Currency) => {
        const direct = crossRate(a, c, FX_BASE_RATES);
        const viaB = crossRate(a, b, FX_BASE_RATES) * crossRate(b, c, FX_BASE_RATES);
        expect(direct).toBeCloseTo(viaB, 6);
      }),
    );
  });

  it("formatRate is stable and parseable", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.000001, max: 1000, noNaN: true }), (rate) => {
        const s = formatRate(rate);
        expect(s).toMatch(/^\d+\.\d{8}$/);
        expect(Number(s)).toBeCloseTo(Number(rate.toFixed(8)), 8);
      }),
    );
  });
});
