/**
 * Tax / VAT engine (ADR 0007) — pure, centime-exact math.
 *
 * CorpoPay is a payment facilitator: the tenant sells the underlying
 * goods/service (and owns its own sales tax), while CorpoPay sells the tenant a
 * payment-processing service. Tax therefore applies to CorpoPay's **fee** —
 * never the tenant's gross. Pricing is **exclusive** (the international B2B
 * convention): the fee is net, tax is added on top and collected separately.
 *
 * `taxRateBps` is a per-tenant basis-point rate (2000 = 20%). A `0` default is
 * correct for B2B cross-border reverse-charge / zero-rated relationships; a
 * domestic tenant sets its local rate. The `taxExempt` flag zeroes the rate
 * where the tenant self-accounts. There is no single global rate — every
 * calculation reads the tenant's configuration.
 *
 * Tax is recorded as its own money movement (a `TAX` category posting into the
 * `TAX_PAYABLE` liability), separate from `FEES` income, so the fee-vs-tax
 * split is always auditable. Remittance/filing is out-of-band (an accounting
 * process, not an API responsibility).
 *
 * Everything here is pure and side-effect-free — that is what makes it
 * property-testable (see `tax.property.test.ts`).
 */
import { applyBps } from "./fees";
import { type Centimes, centimes } from "./money";

/** Tenant tax configuration (rate + exemption). */
export interface TaxSpec {
  /** Basis-point tax rate applied to CorpoPay's fee (0 = no tax). */
  taxRateBps: number;
  /** Exempt / reverse-charge: zeroes the rate (tenant self-accounts). */
  taxExempt?: boolean;
}

export class TaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxError";
  }
}

/**
 * Tax on CorpoPay's fee (exclusive pricing). Returns 0 when there is no tax
 * config, the tenant is exempt, or the rate is 0. Rounded to the nearest
 * centime (round half away from zero) — the same single rounding rule as fees.
 */
export function computeTax(feeCents: Centimes, tax: TaxSpec | null | undefined): Centimes {
  if (!tax || tax.taxExempt || tax.taxRateBps === 0) return centimes(0);
  if (tax.taxRateBps < 0) throw new TaxError("taxRateBps must be non-negative");
  return applyBps(feeCents, tax.taxRateBps);
}
