# CorpoPay Finance Engine — config-driven money models

Status: **Phase A + B + C + D complete.**

## Goal

Make every money-flow feature a **tenant-toggleable capability** so CorpoPay can sell
each feature individually and a tenant's entire money model is just the set of enabled
capabilities. Presets are shortcuts (not constraints); a pure validator is the "smartness"
that blocks combinations that cannot work.

## Principles

1. **Capability over enum** — no fixed "money model" enum. Each feature is an independent on/off toggle.
2. **Presets are shortcuts** — a preset seeds the toggles; the tenant can then flip any toggle.
3. **Smartness = validation** — a pure validator rejects invalid combos (unknown keys, duplicates, unmet prerequisites).
4. **Settlement is separate** — money *flow* (this engine) vs. money *payout* (`SettlementPolicy` + payout rail) stay decoupled.
5. **Money invariant** — DB per-currency `Decimal(12,2)` (MAD, USD, EUR, GBP, CAD); API/providers integer centimes via `src/lib/money.ts`. This layer never touches amounts.

## Capabilities (sellable features)

| Key | Feature | Prerequisite |
|---|---|---|
| `INSTANT_CAPTURE` | one-time charge, capture immediately | — |
| `PREAUTH_CAPTURE` | authorize now, capture later | — |
| `WALLET` | stored-value / pre-funded balance | — |
| `SUBSCRIPTIONS` | recurring billing | a capture method |
| `INSTALLMENTS` | BNPL (down payment + schedule) | a capture method |
| `MARKETPLACE_SPLITS` | split payouts to beneficiaries | a capture method |

## Wallet commission basis (per-capability setting)

The `WALLET` capability has one knob — *when* CorpoPay takes its commission:

| Basis | Commission charged on | Model |
|---|---|---|
| `usage` (default) | each draw-down (debit) | OtoParking pay-as-you-go |
| `load` | each top-up (credit the net, fee out of the wallet) | pre-funded with load fee |

The setting is a no-op unless `WALLET` is enabled. The `wallet` preset + the
`usage` default together encode the OtoParking model; a tenant can flip to `load`
independently without changing capabilities.

## Validation (the "smartness")

A capability set is invalid if any of these hold:

1. it contains an unknown key (`UNKNOWN_CAPABILITY`);
2. it contains a duplicate key (`DUPLICATE_CAPABILITY`);
3. `SUBSCRIPTIONS`, `INSTALLMENTS`, or `MARKETPLACE_SPLITS` is enabled without `INSTANT_CAPTURE` or `PREAUTH_CAPTURE` (`REQUIRES_CAPTURE_FUNDING`);
4. `walletCommissionBasis` is not `usage` or `load` (`INVALID_WALLET_COMMISSION_BASIS`).

That is the whole rule set today — deliberately minimal, and it only grows when a new
capability introduces a real conflict or prerequisite.

## Presets

- `standard` — `INSTANT_CAPTURE`, `PREAUTH_CAPTURE`, `SUBSCRIPTIONS`, `INSTALLMENTS`
- `wallet` — `WALLET`, `INSTANT_CAPTURE` (card top-up)  ·  **OtoParking**
- `marketplace` — `INSTANT_CAPTURE`, `PREAUTH_CAPTURE`, `MARKETPLACE_SPLITS`
- `full` — all six

`jabadoor` maps to `standard` (auth→capture is the `PREAUTH_CAPTURE` path).

Default (no `FinanceConfig` row): **`full`** — total flexibility; gating only applies once a tenant has an explicit subset.

## Schema

```prisma
model FinanceConfig {
  id                    String   @id @default(cuid())
  tenantId              String   @unique
  capabilities          String[] @default([]) // FinanceCapability keys
  preset                String?               // standard | wallet | marketplace | full | custom
  walletCommissionBasis String   @default("usage") // usage | load
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("finance_configs")
}
```

## What already exists (do not rebuild)

- `Wallet` + `WalletTransaction` — stored value; refund-to-wallet = `REFUND`, support credit = `ADJUSTMENT` (signed minor units).
- `FeeSchedule` (`FLAT` / `PERCENTAGE` / `TIERED` / `PER_METHOD`) + `resolveFeeSpec`.
- `SettlementPolicy` — reserve, availability, payout schedule, `splittingEnabled`, `industry` (already "defaults the policy preset").
- `SplitParty` / `SplitRule` / `Split` — marketplace Model A.
- `PaymentLink.isRecurring` / `isInstallment`.
- `MerchantOnboarding.industry` / `mcc` / `riskTier`.

## What's new (the capability layer)

1. `FinanceConfig` entity — capability toggles + `preset` (migration `20260907200000_add_finance_config`).
2. `src/lib/finance-config.ts` — pure validator + preset constants (unit-tested).
3. `src/lib/finance-config-db.ts` — `getEffectiveCapabilities` (default `full`), `upsertFinanceConfig`, `requireCapability`.
4. `GET` / `PUT /finance-config` (owner) + `schemas/finance-config.ts`.
5. Gating at creation: payment links (`isRecurring`→`SUBSCRIPTIONS`, `isInstallment`→`INSTALLMENTS`), wallets (`WALLET`), split rules (`MARKETPLACE_SPLITS`).
6. `walletCommissionBasis` (`usage` | `load`) on `FinanceConfig` + `topUpWithFee` pure helper, wired into `topUpWallet` / `debitWallet` so the wallet charges commission on either load or draw-down.

## Phases

- **A** — `src/lib/finance-config.ts` validator + tests (pure, no migration). ✅
- **B** — `FinanceConfig` schema + migration, route + creation gating. ✅
- **C** — wallet commission basis (`usage` vs `load`) and the OtoParking `wallet` preset + `usage` default. ✅
- **D** — settlement/owed surface (Tier 2): `payoutRail` (`STRIPE_CONNECT` vs `MANUAL`) on `SettlementPolicy`, and `GET /settlement/summary` (net-owed = `AVAILABLE`, with fee/reserve/paid-out breakdown + eligible-after-scheduled). ✅
- **D.1** — `MANUAL` payout rail wired end-to-end: `POST /payouts/:id/process` branches on the active policy's `payoutRail` — `MANUAL` confirms an out-of-band transfer (optional `providerTransferId`, **no provider call**) and posts `AVAILABLE → PAID_OUT`; `STRIPE_CONNECT` still dispatches the provider adapter. Route + integration tests added. ✅
