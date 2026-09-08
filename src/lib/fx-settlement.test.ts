import { describe, expect, it } from "vitest";
import {
  FX_ADJUSTMENT_SOURCE_TYPE,
  FX_CONVERSION_SOURCE_TYPE,
  planFxConversion,
} from "./fx-settlement";
import { centimes } from "./money";

describe("planFxConversion", () => {
  it("converts at the locked rate with zero gain/loss when locked == reference", () => {
    const plan = planFxConversion({
      from: "EUR",
      to: "MAD",
      amountFromMinor: centimes(1000), // 10.00 EUR
      lockedRate: "11.02000000",
      referenceRate: "11.02000000",
    });

    expect(plan.amountToMinor).toBe(11020); // 110.20 MAD
    expect(plan.gainLossMinor).toBe(0);
    expect(plan.postings).toHaveLength(2); // drain + credit, no FX_ADJUSTMENT
  });

  it("books a positive FX gain when the reference rate is better than locked", () => {
    const plan = planFxConversion({
      from: "EUR",
      to: "MAD",
      amountFromMinor: centimes(1000),
      lockedRate: "11.02000000", // tenant is owed 110.20 MAD
      referenceRate: "11.20000000", // CorpoPay obtains 112.00 MAD
    });

    expect(plan.amountToMinor).toBe(11020);
    expect(plan.gainLossMinor).toBe(180); // 11200 − 11020
    expect(plan.postings).toHaveLength(3);

    const fxAdj = plan.postings[2];
    expect(fxAdj.sourceType).toBe(FX_ADJUSTMENT_SOURCE_TYPE);
    expect(fxAdj.debit.account).toBe("CASH");
    expect(fxAdj.credit.account).toBe("FEES");
    expect(fxAdj.debit.amountCents).toBe(180);
  });

  it("books a negative FX loss when the reference rate is worse than locked", () => {
    const plan = planFxConversion({
      from: "EUR",
      to: "MAD",
      amountFromMinor: centimes(1000),
      lockedRate: "11.02000000",
      referenceRate: "10.90000000", // CorpoPay obtains only 109.00 MAD
    });

    expect(plan.amountToMinor).toBe(11020);
    expect(plan.gainLossMinor).toBe(-120); // 10900 − 11020
    expect(plan.postings).toHaveLength(3);

    const fxAdj = plan.postings[2];
    expect(fxAdj.debit.account).toBe("FEES");
    expect(fxAdj.credit.account).toBe("CASH");
    expect(fxAdj.debit.amountCents).toBe(120);
  });

  it("drains the source AVAILABLE and credits the settlement AVAILABLE", () => {
    const plan = planFxConversion({
      from: "USD",
      to: "CAD",
      amountFromMinor: centimes(5000),
      lockedRate: "1.30000000",
      referenceRate: "1.30000000",
    });

    const [drain, creditSettlement] = plan.postings;
    expect(drain.sourceType).toBe(FX_CONVERSION_SOURCE_TYPE);
    expect(drain.debit.account).toBe("AVAILABLE");
    expect(drain.debit.currency).toBe("USD");
    expect(drain.credit.account).toBe("CASH");
    expect(drain.credit.currency).toBe("USD");

    expect(creditSettlement.debit.account).toBe("CASH");
    expect(creditSettlement.debit.currency).toBe("CAD");
    expect(creditSettlement.credit.account).toBe("AVAILABLE");
    expect(creditSettlement.credit.currency).toBe("CAD");
  });

  it("rejects a same-currency pair", () => {
    expect(() =>
      planFxConversion({
        from: "MAD",
        to: "MAD",
        amountFromMinor: centimes(1000),
        lockedRate: "1",
        referenceRate: "1",
      }),
    ).toThrow(/cross-currency/);
  });
});
