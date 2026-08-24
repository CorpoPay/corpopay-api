/**
 * Billing utilities — date math for subscription cycles + installment amortization.
 */
import { BillingInterval } from "@/generated/prisma/client";

// ─── Installment / BNPL ────────────────────────────────────────────────────────

/**
 * Standard amortization: monthly payment on a loan of `principal` MAD at
 * `annualRatePct` % APR spread over `n` months.
 *
 * Formula:  M = P × r(1+r)^n / ((1+r)^n − 1)
 * where r = annualRatePct / 100 / 12
 *
 * When APR = 0, returns P / n (exact equal split, no rounding error from formula).
 * Result is rounded UP to the nearest centime so the lender never short-collects;
 * the final installment is adjusted down to collect exactly the outstanding balance.
 */
export function computeInstallmentAmount(
  principal: number, // MAD
  annualRatePct: number,
  n: number,
): number {
  if (n <= 0) throw new Error("n must be positive");
  if (principal <= 0) return 0;
  if (annualRatePct === 0) {
    return Math.round((principal / n) * 100) / 100;
  }
  const r = annualRatePct / 100 / 12;
  const factor = Math.pow(1 + r, n);
  const payment = (principal * (r * factor)) / (factor - 1);
  // Round UP to nearest centime
  return Math.ceil(payment * 100) / 100;
}

/** Total interest paid = n × monthly − principal */
export function totalInterest(principal: number, annualRatePct: number, n: number): number {
  if (annualRatePct === 0) return 0;
  const monthly = computeInstallmentAmount(principal, annualRatePct, n);
  return Math.round((monthly * n - principal) * 100) / 100;
}

/**
 * Compute the next billing date given a start date and billing interval.
 */
export function computeNextBillingDate(
  from: Date,
  intervalType: BillingInterval,
  intervalValue: number = 1,
): Date {
  const next = new Date(from);

  switch (intervalType) {
    case "DAILY":
      next.setUTCDate(next.getUTCDate() + intervalValue);
      break;
    case "WEEKLY":
      next.setUTCDate(next.getUTCDate() + intervalValue * 7);
      break;
    case "MONTHLY":
      next.setUTCMonth(next.getUTCMonth() + intervalValue);
      break;
    case "QUARTERLY":
      next.setUTCMonth(next.getUTCMonth() + intervalValue * 3);
      break;
    case "ANNUAL":
      next.setUTCFullYear(next.getUTCFullYear() + intervalValue);
      break;
    case "CUSTOM":
      // intervalValue is in days for CUSTOM
      next.setUTCDate(next.getUTCDate() + intervalValue);
      break;
    default:
      next.setUTCMonth(next.getUTCMonth() + 1);
  }

  return next;
}

/**
 * Generate a deterministic idempotency key for a billing cycle.
 * Pattern: {subscriptionId}-{YYYY-MM-DD}
 */
export function billingIdempotencyKey(subscriptionId: string, date: Date): string {
  const ymd = date.toISOString().slice(0, 10);
  return `${subscriptionId}-${ymd}`;
}

/**
 * Stub: send a customer notification about a subscription billing event.
 * Wire your own email HTTP endpoint here.
 */
export async function notifySubscriptionEvent(params: {
  event: "payment_success" | "payment_failed" | "subscription_cancelled" | "subscription_created";
  tenantId: string;
  customerId: string;
  subscriptionId: string;
  amount?: number;
  currency?: string;
  attemptNumber?: number;
  nextRetryDate?: Date;
}): Promise<void> {
  // TODO: replace with your email endpoint
  // Example:
  // await fetch(process.env.EMAIL_ENDPOINT_URL!, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(params),
  // });
  console.log("[billing] notifySubscriptionEvent", params);
}
