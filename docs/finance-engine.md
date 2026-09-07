# CorpoPay Finance Engine — config-driven money models

Status: **Design locked / Phase A in progress.**

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
5. **Money invariant** — DB `MAD Decimal(12,2)`; API/providers integer centimes via `src/lib/money.ts`. This layer never touches amounts.

## Capabilities (sellable features)

| Key | Feature | Prerequisite |
|---|---|---|
| `INSTANT_CAPTURE` | one-time charge, capture immediately | — |
| `PREAUTH_CAPTURE` | authorize now, capture later | — |
| `WALLET` | stored-value / pre-funded balance | — |
| `SUBSCRIPTIONS` | recurring billing | a capture method |
| `INSTALLMENTS` | BNPL (down payment + schedule) | a capture method |
| `MARKETPLACE_SPLITS` | split payouts to beneficiaries | a capture method |

## Validation (the "smartness")

A capability set is invalid if any of these hold:

1. it contains an unknown key (`UNKNOWN_CAPABILITY`);
2. it contains a duplicate key (`DUPLICATE_CAPABILITY`);
3. `SUBSCRIPTIONS`, `INSTALLMENTS`, or `MARKETPLACE_SPLITS` is enabled without `INSTANT_CAPTURE` or `PREAUTH_CAPTURE` (`REQUIRES_CAPTURE_FUNDING`).

That is the whole rule set today — deliberately minimal, and it only grows when a new
capability introduces a real conflict or prerequisite.

## Presets

- `standard` — `INSTANT_CAPTURE`, `PREAUTH_CAPTURE`, `SUBSCRIPTIONS`, `INSTALLMENTS`
- `wallet` — `WALLET`, `INSTANT_CAPTURE` (card top-up)  ·  **OtoParking**
- `marketplace` — `INSTANT_CAPTURE`, `PREAUTH_CAPTURE`, `MARKETPLACE_SPLITS`
- `full` — all six

`jabadoor` maps to `standard` (auth→capture is the `PREAUTH_CAPTURE` path).

## Schema (Phase A)

```prisma
model FinanceConfig {
  id           String   @id @default(cuid())
  tenantId     String   @unique
  capabilities String[] @default([]) // FinanceCapability keys
  preset       String?               // standard | wallet | marketplace | full | custom
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("finance_configs")
}
```

## What already exists (do not rebuild)

- `Wallet` + `WalletTransaction` — stored value; refund-to-wallet = `REFUND`, support credit = `ADJUSTMENT` (signed MAD).
- `FeeSchedule` (`FLAT` / `PERCENTAGE` / `TIERED` / `PER_METHOD`) + `resolveFeeSpec`.
- `SettlementPolicy` — reserve, availability, payout schedule, `splittingEnabled`, `industry` (already "defaults the policy preset").
- `SplitParty` / `SplitRule` / `Split` — marketplace Model A.
- `PaymentLink.isRecurring` / `isInstallment`.
- `MerchantOnboarding.industry` / `mcc` / `riskTier`.

## What's new (the capability layer)

1. `FinanceConfig` entity — capability toggles + `preset`.
2. `src/lib/finance-config.ts` — pure validator + preset constants (Phase A, no migration).
3. Presets seeding on tenant onboarding (Phase B).
4. API/UI gating — read capabilities to show/hide features; write toggles through the validator (Phase B).

## Phases

- **A** — `src/lib/finance-config.ts` validator + tests (pure, no migration).
- **B** — `FinanceConfig` schema + migration, route/UI gating, onboarding preset.
- **C** — wallet commission basis (`usage` vs `load`) and any OtoParking-specific config.
- **D** — settlement/owed surface (Tier 2), with the payout rail (`stripe_connect` vs `manual`) kept in `SettlementPolicy`, not here.
