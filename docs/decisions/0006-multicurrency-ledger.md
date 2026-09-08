# 6. Multi-currency ledger + FX

- Status: Accepted
- Date: 2026-09-07

## Context

The ledger is currently MAD-only: `money.ts` exposes `madToCentimes` /
`centimesToMad`, `LedgerEntry` rows are written with a hard-coded `"MAD"`, and
balances are computed per account without a currency dimension. Non-MAD settlement
was deferred (§11 of `payfac-money-movement.md`).

Tenants span multiple geographies and settle in their own currency, so a MAD-only
ledger cannot represent a USD tenant receiving a EUR payment without silently
losing currency.

## Decision

- **Multi-currency ledger** (not boundary-only conversion): every money row carries
  an ISO 4217 `currency`, and balances are computed **per (account, currency)**.
  Money never mixes currencies inside a single balance.
- **v1 currencies**: `MAD`, `USD`, `EUR`, `GBP`, `CAD`. All five are two-decimal
  minor units, so the existing `Decimal(12,2)` column and the integer-centime
  (minor-unit) boundary math carry over unchanged per currency.
- **Settlement currency is per tenant**: a tenant's payouts are made in their
  configured `settlementCurrency`, independent of the currency(s) their customers
  paid in.
- **FX risk sits with the tenant.** CorpoPay quotes a rate *before* the tenant acts
  (payment link / payout), the tenant confirms, and that rate is **locked** onto the
  resulting ledger postings. Any later market movement is the tenant's exposure,
  not CorpoPay's.
- **Rate source**: prefer a free reference-rate provider. Stripe's FX conversion
  carries a fee and is therefore not the default; use a free daily reference-rate
  source (e.g. ECB for EUR-anchored rates) with a **deterministic sandbox fallback**
  so tests and demos are reproducible. The exact provider is a config value, not a
  code-level commitment.
- **Conversion boundary**: all conversion goes through a currency-aware `money.ts`;
  centime (minor-unit) exactness is preserved per currency; a conversion produces an
  explicit `FX_ADJUSTMENT` posting so the gain/loss is auditable.

## Consequences

- `money.ts` generalizes from `madToCentimes`/`centimesToMad` to
  `toMinor(amount, currency)` / `fromMinor(minor, currency)` (MAD helpers remain as
  aliases). Never multiply/divide ad hoc.
- `LedgerEntry.currency` becomes meaningful; `getTenantLedger` and
  `accountBalanceCents` return per-currency balances, and `isBalanced` asserts
  per-currency.
- Payout eligibility and the `createPayout`/`markPayoutPaid` snapshot become
  currency-aware (a payout settles in the tenant's currency).
- A `Tenant.settlementCurrency` (default `MAD`) and a locked-rate mechanism
  (quoted rate + expiry, stored on the intent/payout) are introduced.
- This is a **large migration**: it touches `money.ts`, the ledger core, the
  `LedgerEntry` schema, every amount-bearing route, all four adapters, and the web
  contract. It is implemented in phases, not as a single change.

## Implementation phases

1. **Currency-aware money + ledger core** (this ADR's `Consequences` first two
   bullets): `money.ts` gains `toMinor`/`fromMinor`/`toMinorString` (MAD helpers
   become aliases); `ledger.ts` carries `currency` on every leg and computes
   per-(account, currency) balances with per-currency `isBalanced`; `ledger-db.ts`
   writes/reads real `LedgerEntry.currency` and exposes `balancesByCurrency`.
   Non-breaking: MAD-only callers keep the existing `balances` projection.
2. **Schema** — add `Tenant.settlementCurrency` (default `MAD`); migrate any
   remaining hard-coded `"MAD"` writes to read the tenant's currency.
3. **Routes + adapters** — amount-bearing routes and the four provider adapters
   pass an explicit currency; `LedgerEntry.currency` is surfaced in responses.
4. **FX provider** — locked-rate quote/expiry on intents and payouts, a free
   reference-rate source with deterministic sandbox fallback, and an explicit
   `FX_ADJUSTMENT` posting for the gain/loss.
