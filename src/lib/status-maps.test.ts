import { describe, expect, it } from "vitest";
import { mapStripeStatus, NAPS_STATUS_MAP, VPS_STATUS_MAP } from "./status-maps";

describe("VPS_STATUS_MAP", () => {
  it.each(["AUTHORISED", "AUTHORIZED", "REDIRECTED", "PENDING_3DS", "CHALLENGE_REQUIRED"])(
    "maps %s → REQUIRES_ACTION",
    (status) => {
      expect(VPS_STATUS_MAP[status]).toBe("REQUIRES_ACTION");
    },
  );

  it.each(["CHARGED", "CAPTURED", "PAID", "SETTLED", "COMPLETED"])("maps %s → SUCCEEDED", (s) => {
    expect(VPS_STATUS_MAP[s]).toBe("SUCCEEDED");
  });

  it.each(["REFUSED", "DECLINED", "FAILED", "ERROR"])("maps %s → FAILED", (s) => {
    expect(VPS_STATUS_MAP[s]).toBe("FAILED");
  });

  it.each(["CANCELLED", "CANCELED", "AUTH_REVERSED", "VOIDED"])("maps %s → CANCELED", (s) => {
    expect(VPS_STATUS_MAP[s]).toBe("CANCELED");
  });

  it.each(["PENDING", "IN_PROGRESS", "PROCESSING"])("maps %s → PROCESSING", (s) => {
    expect(VPS_STATUS_MAP[s]).toBe("PROCESSING");
  });

  it("maps REFUNDED → REFUNDED", () => {
    expect(VPS_STATUS_MAP["REFUNDED"]).toBe("REFUNDED");
  });
});

describe("NAPS_STATUS_MAP", () => {
  it.each(["APPROVED", "CAPTURED"])("maps %s → SUCCEEDED", (s) => {
    expect(NAPS_STATUS_MAP[s]).toBe("SUCCEEDED");
  });

  it.each(["DECLINED", "REFUSED", "EXPIRED"])("maps %s → FAILED", (s) => {
    expect(NAPS_STATUS_MAP[s]).toBe("FAILED");
  });

  it("maps PENDING → PROCESSING and INITIATED → REQUIRES_ACTION", () => {
    expect(NAPS_STATUS_MAP["PENDING"]).toBe("PROCESSING");
    expect(NAPS_STATUS_MAP["INITIATED"]).toBe("REQUIRES_ACTION");
  });

  it.each(["REFUNDED", "PARTIALLREFUNDED"])("maps %s → REFUNDED", (s) => {
    expect(NAPS_STATUS_MAP[s]).toBe("REFUNDED");
  });
});

describe("mapStripeStatus", () => {
  it.each([
    ["succeeded", "SUCCEEDED"],
    ["requires_action", "REQUIRES_ACTION"],
    ["requires_payment_method", "REQUIRES_ACTION"],
    ["processing", "PROCESSING"],
    ["requires_capture", "PROCESSING"],
    ["canceled", "CANCELED"],
  ])("maps Stripe PaymentIntent %s → %s", (stripeStatus, internal) => {
    expect(mapStripeStatus(stripeStatus)).toBe(internal);
  });

  it.each([
    ["paid", "SUCCEEDED"],
    ["unpaid", "REQUIRES_ACTION"],
    ["no_payment_required", "SUCCEEDED"],
  ])("maps Stripe Checkout Session payment_status %s → %s", (stripeStatus, internal) => {
    expect(mapStripeStatus(stripeStatus)).toBe(internal);
  });

  it("defaults to PROCESSING for unknown statuses", () => {
    expect(mapStripeStatus("some_future_status")).toBe("PROCESSING");
    expect(mapStripeStatus("")).toBe("PROCESSING");
  });
});
