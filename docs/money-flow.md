# Money flow — settlement & ledger map

Status: **current** (source of truth: `src/lib/*`; this doc mirrors the code).

CorpoPay is a **PayFac** (payment facilitator): it collects customer funds on behalf
of its tenants, takes a commission, optionally holds a reserve, and settles the
remainder. Every unit of currency that moves is recorded as a balanced double-entry
posting — the invariant **Σ debits = Σ credits** must hold after every write, and the
DB stores **per-currency `Decimal(12,2)`** (MAD, USD, EUR, GBP, CAD) while the API and
providers speak integer
**centimes** (all conversion through `src/lib/money.ts`).

---

## 1. Ledger accounts

Per tenant, `src/lib/ledger.ts` defines nine accounts. Balance convention is
`balance = Σ credits − Σ debits`, so **liability/income accounts are credit-positive**
and **asset accounts are debit-negative**.

| Account | Kind | Meaning | Positive when |
|---|---|---|---|
| `CASH` | asset | money actually in CorpoPay's pool attributable to the tenant | negative (debit) |
| `PENDING` | asset | captured but not yet settled by the provider | negative |
| `COLLECTED` | liability | gross customer funds owed to the tenant | positive |
| `AVAILABLE` | liability | subset of collected eligible for payout | positive |
| `RESERVE` | liability | held back against reversals | positive |
| `FEES` | income | CorpoPay revenue | positive |
| `PAID_OUT` | contra-liability | cumulative amount settled to the tenant | positive |
| `WALLET` | liability | customer stored value (prepaid / OtoParking model) | positive |
| `TAX_PAYABLE` | liability | VAT/GST on CorpoPay's fee (remitted, not revenue) | positive |

> `PENDING` is currently **defined but never posted** — a placeholder for
> "captured, awaiting provider settlement". Capture settlement uses `COLLECTED` as
> the intermediate, not `PENDING` (consistent with `executeSplit`'s `AT_CAPTURE`).

---

## 2. Capture settlement (card payments) — `src/lib/settlement.ts` / `settlement-db.ts`

The entry point that turns a successful provider capture into tenant money. It runs
on **all three** success paths (`webhookProcessor` VPS/NAPS, `stripeWebhookProcessor`,
and `captureIntent` manual/admin capture) and is **idempotent** — keyed on the
intent id (`sourceType=payment_intent`), so replayed webhooks or a concurrent settle
never double-book.

For a gross capture `G`, a fee `F` (`computeFee`), tax `T` (`computeTax` on the fee),
and a reserve `R` (`computeReserve`), `settleCapture` posts up to five balanced legs:

| # | Debit | Credit | Category | When |
|---|---|---|---|---|
| 1 | `CASH` G | `COLLECTED` G | `CAPTURE` | always |
| 2 | `COLLECTED` F | `FEES` F | `FEE` | `F > 0` |
| 3 | `COLLECTED` T | `TAX_PAYABLE` T | `TAX` | `T > 0` |
| 4 | `COLLECTED` R | `RESERVE` R | `CAPTURE` | `R > 0` |
| 5 | `COLLECTED` (G−F−T−R) | `AVAILABLE` (G−F−T−R) | `CAPTURE` | net > 0 |

Net effect: `CASH = −G`, `FEES = F`, `TAX_PAYABLE = T`, `RESERVE = R`, `AVAILABLE = G−F−T−R`,
`COLLECTED = 0`. Sum of all balances is always `0`.

- **Fee** = active `FeeSchedule` (overrides) else the tenant's preset fee
  (`presetForIndustry(industry).fee`, default 2.9%).
- **Reserve** = active `SettlementPolicy` (self-contained row) else `DEFAULT_PRESET`
  (5% rolling). See `src/lib/settlement-policy.ts` for the dimension model.
- **Tax** = the tenant's `taxRateBps`/`taxExempt` (`computeTax` on the fee — exclusive
  pricing: tax applies to CorpoPay's commission, never the gross). See ADR 0007.
- **Splits** = when `splittingEnabled` + an active `AT_CAPTURE` `SplitRule` exist,
  the gross is split into beneficiary shares + platform remainder first, and the
  fee + reserve are then computed on the **platform remainder** (see §3 + gap #4).

### 2.1 The gap this closes

Before this wiring, **no card capture ever posted a ledger entry** — the three
success paths only flipped `PaymentIntent.status`, marked the link `PAID`, and
fired notifications. `AVAILABLE` was therefore never funded, `createPayout` always
snapshotted zero, and fees/splits/disputes had nothing to operate on. The wallet
path (`wallet-db.ts`) was already fully wired; this closes the equivalent gap for
card payments.

---

## 3. Other money movements

| Flow | Postings | Module |
|---|---|---|
| **Wallet top-up** (OtoParking prepaid) | `CASH → WALLET` | `wallet-db.ts` |
| **Wallet draw-down** (pay-as-you-use) | `WALLET → AVAILABLE`, then `AVAILABLE → FEES` | `wallet-db.ts` |
| **Wallet refund** | `AVAILABLE → WALLET` | `wallet-db.ts` |
| **Wallet adjustment** | `WALLET ⇄ AVAILABLE` | `wallet-db.ts` |
| **Payout** | `AVAILABLE → PAID_OUT` (net eligible: unpaid credits − non-payout debits) | `payout-db.ts` |
| **Split (AT_CAPTURE)** | `COLLECTED → AVAILABLE/RESERVE` per party + platform remainder `COLLECTED → AVAILABLE` | `splits-db.ts` |
| **Split (ON_USAGE/MANUAL)** | `AVAILABLE → AVAILABLE/RESERVE` per party | `splits-db.ts` |
| **Split release** (escrow) | `RESERVE → AVAILABLE` | `splits-db.ts` |
| **Dispute LOST** (chargeback clawback) | `AVAILABLE → CASH` and/or `RESERVE → CASH`, shortfall → `Recovery` receivable | `reversals-db.ts` |
| **Refund (card)** | `AVAILABLE + FEES + RESERVE → CASH` (full unwind of the capture) | `refund-db.ts` |

---

## 3.5 Net-owed summary + payout rail (Tier 2)

`src/lib/settlement-summary.ts` / `settlement-summary-db.ts` / `routes/settlement.ts`

The single number an admin needs to settle a tenant — how much CorpoPay still owes
after commission, fees, reserve and reversals — is `GET /settlement/summary`:

| Field | Meaning |
|---|---|
| `availableCents` | **net owed** — the `AVAILABLE` balance (gross − fee − tax − reserve − already paid out) |
| `scheduledCents` | funds already reserved by open (`DRAFT`/`SCHEDULED`/`PENDING`/`PROCESSING`) payouts |
| `eligibleCents` | `available − scheduled`, floored at 0 — what can be paid right now |
| `feesCents` | CorpoPay revenue to date (`FEES`) |
| `reserveCents` | held back against reversals (`RESERVE`) |
| `paidOutCents` | cumulative amount already settled (`PAID_OUT`) |
| `payoutRail` | `MANUAL` (admin pays out-of-band, e.g. Morocco) or `STRIPE_CONNECT` (automatic international) |

`payoutRail` is a **`SettlementPolicy`** dimension (not a money-model concern) —
default `MANUAL`, overridable per tenant. It lives in `settlement-policy.ts` /
`policy-db.ts`, never in the ledger or capture math. `POST /payouts/:id/process`
honors it: `MANUAL` confirms the operator's out-of-band transfer (optional
`providerTransferId`, **no provider call**) and posts `AVAILABLE → PAID_OUT`; only
`STRIPE_CONNECT` dispatches the provider adapter's `createPayout`.

---

## 4. Known gaps & follow-ups

These are the next money-path hardening items (audited, not yet fixed here):

1. **~~Payout over-pay~~ — fixed.** `createPayout` snapshots the **net** eligible
   balance (unpaid credits − non-payout debits) with FIFO allocation, and
   `markPayoutPaid` now re-validates against the current AVAILABLE balance (throws
   if a clawback/refund landed after the DRAFT snapshot). `FAILED`/`CANCELLED`
   payouts release their `PayoutItem`s so the credits can be re-reserved.

2. **~~Fee default inconsistent between surfaces~~ — fixed.** Both `settleCapture`
   and `wallet-db.debitWallet` now resolve the fee through the shared
   `resolveFeeSpec` helper (explicit active `FeeSchedule` wins, else the tenant's
   industry preset fee — default 2.9%). A tenant with no explicit `FeeSchedule` no
   longer silently pays 0 on wallet draw-downs.

3. **~~Refund posts no ledger movement~~ — fixed.** `settleRefund` now unwinds the
   capture's settlement (`AVAILABLE + FEES + RESERVE → CASH`), idempotently, so a
   refunded payment leaves the payout-eligible balance. Remaining edge case: a
   refund **after** payout throws `REFUND_AFTER_PAYOUT` (the net was already
   disbursed) — needs a receivable / clawback-from-`PAID_OUT` follow-up.

4. **~~`executeSplit` not wired to capture~~ — fixed (Model A).** `settleCapture`
   splits the gross among beneficiaries + platform remainder when the policy has
   `splittingEnabled` and an active `AT_CAPTURE` rule, then funds fee + reserve from
   the platform remainder. `releaseSplit` remains the manual escrow-release step.

5. **~~Dead `payment/captured` / `payment/canceled` events~~ — fixed.** Removed from
   `intent-actions.ts` (replaced by inline `settleCapture`) and dropped from
   `routes/simulation.ts`, which no longer emits either.

6. **`PENDING` account is reserved (not yet used).** It represents "captured, not yet
   provider-settled" and is intentionally kept as a dormant balance-sheet line until
   authorized/pre-auth holds are wired to it. Dropping the enum value would need an
   `ALTER TYPE` recreation — not worth it for a placeholder.

---

## 5. Where it's validated

- **Pure math** — `src/lib/settlement.test.ts`, `settlement.property.test.ts`
  (fee+tax+reserve+net = gross; whole-centime; reserve ≤ gross).
- **Real Postgres** — `tests/db/settlement.db.test.ts` (`npm run test:db`): capture
  → fee/reserve/available correctness, idempotency, preset default, and a full
  capture → payout → dispute → wallet lifecycle that stays net-zero.
- **End-to-end** — the capture step is wired into the VPS webhook processor, the
  Stripe webhook processor, and manual/admin capture (`intent-actions.ts`).
