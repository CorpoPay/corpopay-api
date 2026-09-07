import { describe, expect, it } from "vitest";

import type { FeeScheduleSpec } from "./fees";
import { centimes } from "./money";
import { CAPTURE_SOURCE_TYPE, planCaptureSettlement, resolveIntentCharge } from "./settlement";
import { type PolicySpec, resolvePolicy } from "./settlement-policy";
import { DEFAULT_PRESET } from "./settlement-presets";

const pct = (percentageBps: number): FeeScheduleSpec => ({
  feeType: "PERCENTAGE",
  flatCents: null,
  percentageBps,
  perMethodCents: null,
  tiersCents: null,
});

/** The default policy: 5% rolling reserve, immediate availability. */
const policy: PolicySpec = resolvePolicy(DEFAULT_PRESET);

describe("planCaptureSettlement", () => {
  it("computes fee, reserve and net in whole centimes", () => {
    const plan = planCaptureSettlement(centimes(10000), pct(290), policy);
    expect(plan.feeCents).toBe(290); // 2.9%
    expect(plan.reserveCents).toBe(500); // 5%
    expect(plan.netCents).toBe(9210); // 100.00 − 2.90 − 5.00
  });

  it("holds back no reserve when the policy is NONE", () => {
    const none: PolicySpec = { ...policy, reserveType: "NONE", reservePercentageBps: null };
    const plan = planCaptureSettlement(centimes(10000), pct(290), none);
    expect(plan.reserveCents).toBe(0);
    expect(plan.netCents).toBe(9710);
  });

  it("caps a FIXED reserve at gross and allows a negative net on a large flat fee", () => {
    const fixed: PolicySpec = {
      ...policy,
      reserveType: "FIXED",
      reserveFixedCents: 999999,
      reservePercentageBps: null,
    };
    const plan = planCaptureSettlement(centimes(10000), pct(290), fixed);
    expect(plan.reserveCents).toBe(10000); // capped at gross
    expect(plan.netCents).toBe(10000 - 290 - 10000); // -290
  });

  it("fee + reserve + net always equals gross", () => {
    const plan = planCaptureSettlement(centimes(12345), pct(350), policy);
    expect(plan.feeCents + plan.reserveCents + plan.netCents).toBe(12345);
  });
});

describe("resolveIntentCharge", () => {
  it("converts a PaymentLink MAD amount to centimes", () => {
    const charge = resolveIntentCharge({
      paymentLink: { amount: 100, currency: "MAD" },
      metadata: null,
    });
    expect(charge.amountCents).toBe(10000);
    expect(charge.currency).toBe("MAD");
  });

  it("reads a direct intent's centime amount from metadata without re-multiplying", () => {
    const charge = resolveIntentCharge({
      paymentLink: null,
      metadata: { amount: 4321, currency: "EUR" },
    });
    expect(charge.amountCents).toBe(4321); // already centimes — never ×100
    expect(charge.currency).toBe("EUR");
  });

  it("defaults to 0 / MAD when no amount is present", () => {
    const charge = resolveIntentCharge({ paymentLink: null, metadata: null });
    expect(charge.amountCents).toBe(0);
    expect(charge.currency).toBe("MAD");
  });
});

describe("CAPTURE_SOURCE_TYPE", () => {
  it("uses the stable 'payment_intent' source type for idempotency", () => {
    expect(CAPTURE_SOURCE_TYPE).toBe("payment_intent");
  });
});
