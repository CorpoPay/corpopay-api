import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { convertMinor } from "./fx";
import { planFxConversion } from "./fx-settlement";
import { isBalanced, type LedgerLeg } from "./ledger";
import { type Currency, centimes, SUPPORTED_CURRENCIES } from "./money";

const currency = fc.constantFrom(...SUPPORTED_CURRENCIES);
const pair = fc.tuple(currency, currency).filter(([from, to]) => from !== to) as fc.Arbitrary<
  [Currency, Currency]
>;

describe("fx-settlement properties", () => {
  it("gain/loss is exactly reference − locked conversion", () => {
    fc.assert(
      fc.property(
        pair,
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        ([from, to], minor, locked, reference) => {
          const plan = planFxConversion({
            from,
            to,
            amountFromMinor: centimes(minor),
            lockedRate: locked.toFixed(8),
            referenceRate: reference.toFixed(8),
          });
          const expectedGain =
            convertMinor(centimes(minor), reference.toFixed(8)) -
            convertMinor(centimes(minor), locked.toFixed(8));
          expect(plan.gainLossMinor).toBe(expectedGain);
        },
      ),
    );
  });

  it("every posting is single-currency and balanced", () => {
    fc.assert(
      fc.property(
        pair,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        ([from, to], minor, locked, reference) => {
          const plan = planFxConversion({
            from,
            to,
            amountFromMinor: centimes(minor),
            lockedRate: locked.toFixed(8),
            referenceRate: reference.toFixed(8),
          });
          for (const posting of plan.postings) {
            const legs: LedgerLeg[] = [posting.debit, posting.credit];
            expect(isBalanced(legs)).toBe(true);
          }
        },
      ),
    );
  });

  it("converted amount is always a whole integer", () => {
    fc.assert(
      fc.property(
        pair,
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        ([from, to], minor, locked) => {
          const plan = planFxConversion({
            from,
            to,
            amountFromMinor: centimes(minor),
            lockedRate: locked.toFixed(8),
            referenceRate: locked.toFixed(8),
          });
          expect(Number.isInteger(plan.amountToMinor)).toBe(true);
        },
      ),
    );
  });
});
