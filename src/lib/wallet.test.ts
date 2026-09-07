import { describe, expect, it } from "vitest";

import type { FeeScheduleSpec } from "./fees";
import { centimes } from "./money";
import {
  adjustment,
  applyMovement,
  computeBalance,
  debit,
  debitWithFee,
  refund,
  topUp,
  WalletError,
  ZERO_FEE_SCHEDULE,
} from "./wallet";

const pct = (percentageBps: number): FeeScheduleSpec => ({
  feeType: "PERCENTAGE",
  flatCents: null,
  percentageBps,
  perMethodCents: null,
  tiersCents: null,
});

describe("computeBalance", () => {
  it("sums signed amounts (positive credits, negative debits)", () => {
    expect(computeBalance([centimes(1000), centimes(-400), centimes(50)])).toBe(650);
    expect(computeBalance([])).toBe(0);
  });
});

describe("applyMovement", () => {
  it("adds the signed movement to the balance", () => {
    expect(applyMovement(centimes(1000), centimes(-250))).toBe(750);
    expect(applyMovement(centimes(1000), centimes(250))).toBe(1250);
  });
});

describe("topUp", () => {
  it("credits the wallet", () => {
    const r = topUp(centimes(0), centimes(1000));
    expect(r.signedAmountCents).toBe(1000);
    expect(r.balanceAfterCents).toBe(1000);
  });

  it("rejects a non-positive amount", () => {
    expect(() => topUp(centimes(0), centimes(0))).toThrow(WalletError);
    expect(() => topUp(centimes(0), centimes(-5))).toThrow(/positive/);
  });
});

describe("debit", () => {
  it("debits the wallet with a negative signed amount", () => {
    const r = debit(centimes(1000), centimes(400));
    expect(r.signedAmountCents).toBe(-400);
    expect(r.balanceAfterCents).toBe(600);
  });

  it("rejects a non-positive amount", () => {
    expect(() => debit(centimes(1000), centimes(0))).toThrow(/positive/);
  });

  it("rejects a debit that exceeds the balance", () => {
    expect(() => debit(centimes(100), centimes(101))).toThrow(WalletError);
    expect(() => debit(centimes(100), centimes(101))).toThrow(/insufficient/);
  });
});

describe("debitWithFee", () => {
  it("computes the commission and nets it off the debit", () => {
    const r = debitWithFee(centimes(100000), centimes(10000), pct(290)); // 100.00 MAD, 2.9%
    expect(r.feeCents).toBe(290);
    expect(r.netCents).toBe(9710);
    expect(r.signedAmountCents).toBe(-10000);
    expect(r.balanceAfterCents).toBe(90000);
  });

  it("uses a method for PER_METHOD schedules", () => {
    const perMethod: FeeScheduleSpec = {
      feeType: "PER_METHOD",
      flatCents: null,
      percentageBps: null,
      perMethodCents: { wallet: 500 },
      tiersCents: null,
    };
    expect(debitWithFee(centimes(10000), centimes(10000), perMethod, "wallet").feeCents).toBe(500);
    expect(debitWithFee(centimes(10000), centimes(10000), perMethod, "card").feeCents).toBe(0);
  });

  it("produces zero commission with the zero schedule", () => {
    const r = debitWithFee(centimes(1000), centimes(1000), ZERO_FEE_SCHEDULE);
    expect(r.feeCents).toBe(0);
    expect(r.netCents).toBe(1000);
  });
});

describe("refund", () => {
  it("credits the wallet", () => {
    const r = refund(centimes(500), centimes(200));
    expect(r.signedAmountCents).toBe(200);
    expect(r.balanceAfterCents).toBe(700);
  });

  it("rejects a non-positive amount", () => {
    expect(() => refund(centimes(500), centimes(0))).toThrow(/positive/);
  });
});

describe("adjustment", () => {
  it("credits on a positive signed amount", () => {
    const r = adjustment(centimes(100), centimes(50));
    expect(r.signedAmountCents).toBe(50);
    expect(r.balanceAfterCents).toBe(150);
  });

  it("debits on a negative signed amount", () => {
    const r = adjustment(centimes(100), centimes(-30));
    expect(r.signedAmountCents).toBe(-30);
    expect(r.balanceAfterCents).toBe(70);
  });

  it("rejects an adjustment that overdraws the wallet", () => {
    expect(() => adjustment(centimes(10), centimes(-11))).toThrow(/overdraw/);
  });
});

describe("WalletError", () => {
  it("defaults its code", () => {
    const e = new WalletError("boom");
    expect(e.code).toBe("WALLET_ERROR");
    expect(e.name).toBe("WalletError");
  });
});
