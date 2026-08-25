import { describe, expect, it, vi } from "vitest";
import {
  billingIdempotencyKey,
  computeInstallmentAmount,
  computeNextBillingDate,
  notifySubscriptionEvent,
  totalInterest,
} from "./billing";

describe("computeInstallmentAmount", () => {
  it("splits principal exactly when APR is 0 (no rounding error)", () => {
    expect(computeInstallmentAmount(1500, 0, 3)).toBe(500);
    expect(computeInstallmentAmount(100, 0, 4)).toBe(25);
  });

  it("returns 0 for a non-positive principal", () => {
    expect(computeInstallmentAmount(0, 12, 3)).toBe(0);
    expect(computeInstallmentAmount(-100, 12, 3)).toBe(0);
  });

  it("throws when n is not positive", () => {
    expect(() => computeInstallmentAmount(1000, 12, 0)).toThrow("n must be positive");
    expect(() => computeInstallmentAmount(1000, 12, -1)).toThrow("n must be positive");
  });

  it("applies the standard amortization formula for a single period", () => {
    // 1 month at 12% APR: monthly = P × (1 + r) = 1000 × 1.01 = 1010
    expect(computeInstallmentAmount(1000, 12, 1)).toBe(1010);
  });

  it("rounds UP to the nearest centime (lender never short-collects)", () => {
    // 12 months at 12% APR → ~88.8488… → ceil → 88.85
    expect(computeInstallmentAmount(1000, 12, 12)).toBe(88.85);
  });

  it("treats a sub-normal (near-zero) APR as zero interest instead of NaN", () => {
    // A denormal double underflows the monthly rate to 0, which would make the
    // amortization denominator (factor - 1) collapse and return NaN.
    expect(computeInstallmentAmount(1500, 5e-324, 3)).toBe(500);
    expect(Number.isFinite(computeInstallmentAmount(1, 6.66133814775094e-13, 1))).toBe(true);
  });

  it("computes a fractional-APR schedule (e.g. 8.99%) deterministically", () => {
    // Sanity: three installments at 8.99% APR on 1500 MAD sum to more than the
    // principal, with each installment rounded up to a whole centime.
    const installment = computeInstallmentAmount(1500, 8.99, 3);
    expect(installment).toBeGreaterThan(500);
    expect(installment).toBe(Math.ceil(installment * 100) / 100);
    expect(installment * 3).toBeGreaterThan(1500);
  });
});

describe("totalInterest", () => {
  it("is zero when APR is 0", () => {
    expect(totalInterest(1500, 0, 3)).toBe(0);
  });

  it("equals n × monthly − principal, rounded to centimes", () => {
    const principal = 1000;
    const apr = 12;
    const n = 12;
    const monthly = computeInstallmentAmount(principal, apr, n);
    expect(totalInterest(principal, apr, n)).toBe(
      Math.round((monthly * n - principal) * 100) / 100,
    );
  });
});

describe("computeNextBillingDate", () => {
  const from = new Date("2026-01-15T00:00:00Z");

  it("advances DAILY by intervalValue days", () => {
    expect(computeNextBillingDate(from, "DAILY", 1).toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("advances WEEKLY by intervalValue weeks", () => {
    expect(computeNextBillingDate(from, "WEEKLY", 1).toISOString()).toBe(
      "2026-01-22T00:00:00.000Z",
    );
  });

  it("advances MONTHLY by intervalValue months", () => {
    expect(computeNextBillingDate(from, "MONTHLY", 1).toISOString()).toBe(
      "2026-02-15T00:00:00.000Z",
    );
  });

  it("advances QUARTERLY by intervalValue quarters", () => {
    expect(computeNextBillingDate(from, "QUARTERLY", 1).toISOString()).toBe(
      "2026-04-15T00:00:00.000Z",
    );
  });

  it("advances ANNUAL by intervalValue years", () => {
    expect(computeNextBillingDate(from, "ANNUAL", 1).toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });

  it("treats CUSTOM intervalValue as days", () => {
    expect(computeNextBillingDate(from, "CUSTOM", 10).toISOString()).toBe(
      "2026-01-25T00:00:00.000Z",
    );
  });

  it("falls back to one month for an unknown interval", () => {
    expect(computeNextBillingDate(from, "UNKNOWN" as never, 1).toISOString()).toBe(
      "2026-02-15T00:00:00.000Z",
    );
  });
});

describe("billingIdempotencyKey", () => {
  it("formats as {subscriptionId}-{YYYY-MM-DD}", () => {
    expect(billingIdempotencyKey("sub-123", new Date("2026-02-15T10:30:00Z"))).toBe(
      "sub-123-2026-02-15",
    );
  });

  it("is stable for the same calendar date regardless of time", () => {
    const morning = billingIdempotencyKey("sub-123", new Date("2026-02-15T00:00:00Z"));
    const evening = billingIdempotencyKey("sub-123", new Date("2026-02-15T23:59:59Z"));
    expect(morning).toBe(evening);
  });
});

describe("notifySubscriptionEvent", () => {
  it("logs the event (stub) and resolves", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const params = {
      event: "payment_success" as const,
      tenantId: "tenant-a",
      customerId: "cust-1",
      subscriptionId: "sub-1",
      amount: 99,
    };

    await expect(notifySubscriptionEvent(params)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[billing] notifySubscriptionEvent", params);

    log.mockRestore();
  });
});
