# 7. Tax / VAT handling

- Status: Accepted
- Date: 2026-09-07

## Context

CorpoPay is a payment facilitator: the tenant sells the underlying goods/service
(and is responsible for its own sales tax), while CorpoPay sells the tenant a
**payment-processing service**. Tax therefore applies to CorpoPay's **fee**, not to
the tenant's gross transaction amount. There is no single correct rate — it depends
on jurisdiction and whether the relationship is treated as a domestic supply or a
B2B cross-border (reverse-charge) supply.

## Decision

- **Tax applies to CorpoPay's fee only** (the value CorpoPay adds), never the
  tenant's gross. This is the universal facilitator model and keeps the tenant in
  control of its own product tax.
- **Configurable rate**: a per-tenant `taxRateBps` (basis points), default `0`.
  A `0` default is correct for B2B cross-border reverse-charge / zero-rated
  relationships; a tenant that is a domestic supply sets its local rate (e.g. 2000
  for 20% VAT).
- **Exclusive pricing**: tax is computed and shown *on top of* the fee, matching the
  international B2B convention (fee is net, tax added separately).
- **Distinct `TAX` ledger category**: tax is recorded as its own money movement,
  separate from `FEES`, so the collected-vs-fee split is always auditable.
- **Flexible, not hard-coded**: a jurisdiction → rate table (config/seed, not code)
  supports any combination; a tenant override wins over the default; an
  **exempt / reverse-charge** flag zeroes the rate where the tenant self-accounts.
- **Remittance is out-of-band**: CorpoPay records and reports the collected tax;
  filing/remittance is an accounting process, not an API responsibility.

## Consequences

- A `taxRateBps` (+ exemption flag) is added to the tenant/fee configuration.
- Fee settlement splits `FEES` from `TAX` when a non-zero rate applies, so payouts
  net out the tax CorpoPay must remit rather than pay out as merchant revenue.
- Both parties win: the tenant sees a transparent, predictable, jurisdiction-correct
  charge and keeps control of its own goods tax; CorpoPay stays compliant without
  over-collecting and can always prove the fee-vs-tax split.
- No code assumes a single global rate; every tax calculation reads the tenant's
  configuration.
