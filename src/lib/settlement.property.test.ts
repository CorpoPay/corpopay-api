import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { FeeScheduleSpec } from "./fees";
import { centimes } from "./money";
import { planCaptureSettlement } from "./settlement";
import type { PolicySpec } from "./settlement-policy";

/**
 * Property tests for the capture-settlement plan. The invariants that matter:
 *   - `fee + reserve + net === gross` for every input (the double-entry identity);
 *   - fee and reserve are whole, non-negative centimes; reserve never exceeds gross;
 *   - with a zero fee + NONE reserve, the full gross is net (nothing is lost).
 */

const amountArb = fc.integer({ min: 0, max: 100_000_000 });
const bpsArb = fc.integer({ min: 0, max: 10_000 });

const percentFeeArb = fc
  .record({
    feeType: fc.constant("PERCENTAGE"),
    flatCents: fc.constant(null),
    percentageBps: bpsArb,
    perMethodCents: fc.constant(null),
    tiersCents: fc.constant(null),
  })
  .map((s) => s as FeeScheduleSpec);

const policyArb = fc
  .record({
    reserveType: fc.constant("ROLLING"),
    reservePercentageBps: bpsArb,
    reserveFixedCents: fc.constant(null),
  })
  .map(
    (r) =>
      ({
        industry: null,
        mcc: null,
        availabilityMode: "IMMEDIATE",
        availabilityDelayDays: null,
        reserveType: r.reserveType,
        reservePercentageBps: r.reservePercentageBps,
        reserveHoldDays: null,
        reserveFixedCents: r.reserveFixedCents,
        payoutSchedule: "AUTO_DAILY",
        payoutMinCents: null,
        reversalFunding: "NET_FROM_AVAILABLE",
        allowNegative: false,
        splittingEnabled: false,
      }) as PolicySpec,
  );

describe("capture-settlement invariants", () => {
  it("fee + reserve + net always equals gross", () => {
    fc.assert(
      fc.property(percentFeeArb, policyArb, amountArb, (fee, policy, amount) => {
        const plan = planCaptureSettlement(centimes(amount), fee, policy);
        expect(plan.feeCents + plan.reserveCents + plan.netCents).toBe(amount);
      }),
    );
  });

  it("fee and reserve are whole, non-negative centimes; reserve never exceeds gross", () => {
    fc.assert(
      fc.property(percentFeeArb, policyArb, amountArb, (fee, policy, amount) => {
        const plan = planCaptureSettlement(centimes(amount), fee, policy);
        expect(Number.isInteger(plan.feeCents)).toBe(true);
        expect(Number.isInteger(plan.reserveCents)).toBe(true);
        expect(Number.isInteger(plan.netCents)).toBe(true);
        expect(plan.feeCents).toBeGreaterThanOrEqual(0);
        expect(plan.reserveCents).toBeGreaterThanOrEqual(0);
        expect(plan.reserveCents).toBeLessThanOrEqual(amount);
      }),
    );
  });

  it("zero fee + NONE reserve keeps the full gross as net", () => {
    const zeroFee: FeeScheduleSpec = {
      feeType: "FLAT",
      flatCents: 0,
      percentageBps: null,
      perMethodCents: null,
      tiersCents: null,
    };
    const none: PolicySpec = {
      industry: null,
      mcc: null,
      availabilityMode: "IMMEDIATE",
      availabilityDelayDays: null,
      reserveType: "NONE",
      reservePercentageBps: null,
      reserveHoldDays: null,
      reserveFixedCents: null,
      payoutSchedule: "AUTO_DAILY",
      payoutMinCents: null,
      reversalFunding: "NET_FROM_AVAILABLE",
      allowNegative: false,
      splittingEnabled: false,
    };
    fc.assert(
      fc.property(amountArb, (amount) => {
        const plan = planCaptureSettlement(centimes(amount), zeroFee, none);
        expect(plan.feeCents).toBe(0);
        expect(plan.reserveCents).toBe(0);
        expect(plan.netCents).toBe(amount);
      }),
    );
  });
});
