# Money flow — settlement & ledger map

Status: **current** (source of truth: `src/lib/*`; this doc mirrors the code).

CorpoPay is a **PayFac** (payment facilitator): it collects customer funds on behalf
of its tenants, takes a commission, optionally holds a reserve, and settles the
remainder. Every dirham that moves is recorded as a balanced double-entry posting —
the invariant **Σ debits = Σ credits** must hold after every write, and the DB
stores **MAD `Decimal(12,2)`** while the API and providers speak integer
**centimes** (all conversion through `src/lib/money.ts`).

---

## 1. Ledger accounts

Per tenant, `src/lib/ledger.ts` defines eight accounts. Balance convention is
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

For a gross capture `G`, a fee `F` (`computeFee`), and a reserve `R`
(`computeReserve`), `settleCapture` posts up to four balanced legs:

| # | Debit | Credit | Category | When |
|---|---|---|---|---|
| 1 | `CASH` G | `COLLECTED` G | `CAPTURE` | always |
| 2 | `COLLECTED` F | `FEES` F | `FEE` | `F > 0` |
| 3 | `COLLECTED` R | `RESERVE` R | `CAPTURE` | `R > 0` |
| 4 | `COLLECTED` (G−F−R) | `AVAILABLE` (G−F−R) | `CAPTURE` | net > 0 |

Net effect: `CASH = −G`, `FEES = F`, `RESERVE = R`, `AVAILABLE = G−F−R`,
`COLLECTED = 0`. Sum of all balances is always `0`.

- **Fee** = active `FeeSchedule` (overrides) else the tenant's preset fee
  (`presetForIndustry(industry).fee`, default 2.9%).
- **Reserve** = active `SettlementPolicy` (self-contained row) else `DEFAULT_PRESET`
  (5% rolling). See `src/lib/settlement-policy.ts` for the dimension model.

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
| **Refund (card)** | status flip only — see §4 | `routes/refunds.ts` |

---

## 4. Known gaps & follow-ups

These are the next money-path hardening items (audited, not yet fixed here):

1. **~~Payout over-pay~~ — fixed.** `createPayout` now snapshots the **net** eligible
   balance (unpaid credits − non-payout debits) with FIFO allocation, so a chargeback
   clawback / wallet fee / refund reduces the payable amount. Remaining payout edge
   cases (separate, still open): a DRAFT payout created *before* a clawback still
   over-pays when later marked `PAID` (no re-validation at `markPayoutPaid`), and
   `FAILED`/`CANCELLED` payouts leave their `PayoutItem`s in place (stuck credits).

2. **Fee default is inconsistent between surfaces.** `settleCapture` falls back to
   the **preset fee** (never a silent 0), but `wallet-db.debitWallet` falls back to
   `ZERO_FEE_SCHEDULE`. Unify: both should default to the preset fee; a tenant with
   no explicit `FeeSchedule` currently pays 0 on wallet draw-downs but the preset
   rate on card captures.

3. **`Refund` (card) posts no ledger movement.** `routes/refunds.ts` flips the
   `Refund`/`PaymentIntent` status and writes an audit log + provider transaction,
   but does not claw `AVAILABLE → CASH` (or reverse fee/reserve). Refunds therefore
   don't reconcile against the settlement ledger. Wire a balanced refund posting.

4. **`executeSplit`/`releaseSplit` are not wired to any capture.** The split engine
   is built and DB-tested but no code path calls it; decide the trigger (on capture
   via settlement policy `splittingEnabled`) and the source (gross vs net).

5. **`payment/captured` / `payment/canceled` were dead events.** Removed from
   `intent-actions.ts` (replaced by an inline `settleCapture`). `routes/simulation.ts`
   still emits both — harmless (no handler) but should be re-pointed at the real
   settlement/void path or removed.

6. **`PENDING` account is unused.** Either wire "captured, not yet provider-settled"
   to it, or drop it to avoid a dormant balance-sheet line.

---

## 5. Where it's validated

- **Pure math** — `src/lib/settlement.test.ts`, `settlement.property.test.ts`
  (fee+reserve+net = gross; whole-centime; reserve ≤ gross).
- **Real Postgres** — `tests/db/settlement.db.test.ts` (`npm run test:db`): capture
  → fee/reserve/available correctness, idempotency, preset default, and a full
  capture → payout → dispute → wallet lifecycle that stays net-zero.
- **End-to-end** — the capture step is wired into the VPS webhook processor, the
  Stripe webhook processor, and manual/admin capture (`intent-actions.ts`).
