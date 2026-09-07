import { describe, expect, it } from "vitest";

import { centimes } from "./money";
import { computeSettlementSummary } from "./settlement-summary";

describe("computeSettlementSummary", () => {
  it("derives net owed from the AVAILABLE balance with the full breakdown", () => {
    const summary = computeSettlementSummary(
      {
        AVAILABLE: centimes(9410),
        FEES: centimes(290),
        RESERVE: centimes(300),
        PAID_OUT: centimes(0),
      },
      centimes(0),
    );
    expect(summary.availableCents).toBe(9410);
    expect(summary.feesCents).toBe(290);
    expect(summary.reserveCents).toBe(300);
    expect(summary.paidOutCents).toBe(0);
    expect(summary.scheduledCents).toBe(0);
    expect(summary.eligibleCents).toBe(9410);
  });

  it("treats missing balances as zero", () => {
    const summary = computeSettlementSummary({}, centimes(0));
    expect(summary.availableCents).toBe(0);
    expect(summary.feesCents).toBe(0);
    expect(summary.reserveCents).toBe(0);
    expect(summary.paidOutCents).toBe(0);
    expect(summary.eligibleCents).toBe(0);
  });

  it("subtracts scheduled payouts from eligible, floored at zero", () => {
    const summary = computeSettlementSummary({ AVAILABLE: centimes(1000) }, centimes(400));
    expect(summary.availableCents).toBe(1000); // net owed unchanged by scheduling
    expect(summary.scheduledCents).toBe(400);
    expect(summary.eligibleCents).toBe(600);

    const over = computeSettlementSummary({ AVAILABLE: centimes(1000) }, centimes(2000));
    expect(over.eligibleCents).toBe(0);
  });
});
