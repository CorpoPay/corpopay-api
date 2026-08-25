# CorpoPay API — Demo Seed & Full Test Coverage Plan

Status: **Plan / specification** (implementation follows in phases).

Two deliverables that make the API safe to ship, demo, and hand to a third party:

1. **Generic demo seed** — a deterministic, idempotent script that creates a complete
   "Demo Merchant" tenant exercising every entity and lifecycle state.
2. **Full test suite** — unit + property + integration + end-to-end flow coverage of
   every router, provider adapter, money path, and webhook path.

> Money invariant (non-negotiable): the DB stores **MAD** as `Decimal(12,2)`; the API
> boundary and provider adapters speak **centimes** (integer). Every conversion goes
> through `src/lib/money.ts`. All amount-related tests must assert centime exactness.

---

## 1. Demo seed (generic)

### 1.1 Deliverables

| File | Purpose |
|---|---|
| `prisma/seed-demo-data.ts` | Typed fixture factory (the single source of demo data). |
| `prisma/seed-demo.ts` | Idempotent seeder that upserts the demo tenant graph. |
| `prisma/reset-demo.ts` | Truncates + re-seeds (safe reset for demos/tests). |
| `package.json` scripts | `db:seed:demo`, `db:reset:demo`. |

### 1.2 The demo tenant graph

One tenant, `slug: "demo"`, `environment: "test"`, `status: "active"`, exercising
**every** entity and lifecycle state so demos and E2E tests share one dataset:

- **Users** — `admin@demo.ma` (`SUPER_ADMIN`), `owner@demo.ma` (merchant owner),
  `viewer@demo.ma` (read-only) — to exercise RBAC.
- **Provider configs** — `fake` (primary, deterministic — used by E2E),
  `stripe` (test keys, sandbox), `vps` (Payzone test credentials).
- **Payment links** — one-time; recurring (monthly); installment-linked; an expired link;
  a cancelled link.
- **Payment intents** — `succeeded`, `pending`, `failed`, `expired`, `refunded`.
- **Transactions** — full lifecycle samples: one clean success, one refunded (partial +
  full), one failed, one with a provider webhook event timeline.
- **Refunds** — partial and full, across providers.
- **Subscriptions** — `active`, `past_due`, `cancelled`, with billing events (paid,
  failed, retried).
- **Installment plan** (`durationMonths`, `annualInterestRate`, min/max) + an
  **agreement** with a down payment and several `InstallmentCharge` rows in mixed states.
- **API keys** — one active, one revoked.
- **Webhook events** — verified + unverified + a duplicate (idempotency sample).

### 1.3 Determinism & idempotency

- Fixed, human-readable slugs/IDs/`correlationId`s (`demo-link-one-time`, etc.).
- `seed-demo.ts` is **idempotent** — safe to run repeatedly (upsert-by-slug).
- `reset-demo.ts` truncates the tenant's rows and re-seeds — used by E2E for a clean slate.
- No `Math.random()` or `Date.now()` in seeds; timestamps are fixed offsets for
  reproducible demos and snapshots.

---

## 2. Test strategy (pyramid)

| Layer | Scope | Tooling | Fast? |
|---|---|---|---|
| **Unit** | `lib/` pure logic (money, billing, dunning, encryption, webhook-verify, status-maps, env, mask) | `vitest` | ✅ in-memory |
| **Property** | money & billing rounding, fee math, installment schedules | `vitest` + `fast-check` | ✅ |
| **Integration** | one file per router, real routes, test DB | `vitest` + `supertest` | ✅ (DB) |
| **E2E flow** | full lifecycle across routes + providers + webhooks | `vitest` + `supertest` + fake adapter | ✅ (DB) |
| **Provider** | stripe/naps/vps adapters with mocked HTTP | `vitest` + `nock`/fake transport | ✅ |
| **Webhook** | signature verification, idempotency, duplicate detection | `vitest` + `supertest` | ✅ |

---

## 3. Every flow — test matrix

### 3.1 Auth & RBAC (`routes/auth.ts`, `routes/users.ts`, `routes/tenant.ts`, `middleware/auth.ts`)
- register → login → `/auth/me` round-trip.
- invalid credentials → 401; disabled tenant → 403.
- role checks: `SUPER_ADMIN` vs merchant vs viewer on every admin/merchant route.
- **Tenant isolation** (critical): a token for tenant A must 404/403 on tenant B's rows
  (cross-tenant IDOR regression).

### 3.2 Payment links (`routes/paymentLinks.ts`)
- create (one-time, recurring, installment) with centime → MAD round-trip.
- list with pagination/filter; get detail (`_count` of intents).
- update; cancel; expire (past `expiresAt` → 410 on public checkout).
- public `GET /public/checkout/:slug` — 200, 404, 410, and amount/currency shape.

### 3.3 Payment intents & pay (`routes/paymentIntents.ts`)
- create intent (fake + stripe + vps), `correlationId` idempotency (replay → same intent).
- status polling; confirm/cancel actions.
- `POST /public/checkout/:slug/pay` — success path, duplicate pay (idempotent), provider
  failure mapping.
- `GET /public/pay/:correlationId` relay — redirect vs payload vs terminal states.

### 3.4 Transactions & refunds (`routes/transactions.ts`, `routes/refunds.ts`)
- list with status/provider/date filters; get detail (timeline, provider txs, refunds,
  webhook events).
- partial refund, full refund, over-refund rejection, refund-on-failed-intent rejection.

### 3.5 Subscriptions & billing (`routes/subscriptions.ts`, `lib/billing.ts`, `lib/dunning.ts`, jobs)
- create via recurring link; list/detail; cancel; retry.
- **Billing math** (unit/property): proration, retry/dunning schedules, grace periods,
  no-double-charge, centime exactness.
- Jobs: `billingDailySweep`, `billingRenewal` — due-detection, renewal, dunning escalation,
  terminal states.

### 3.6 Installments (`routes/installmentPlans.ts`, `routes/installmentAgreements.ts`)
- plan CRUD + min/max/APR validation.
- agreement creation (down payment + schedule), installment charges over time,
  early payoff, cancellation, `paidCount`/`nextChargeDate` correctness.
- job: `installmentCharge`.

### 3.7 Providers (`src/adapters/*`)
- **fake** — deterministic, used as the E2E backbone.
- **stripe / naps / vps** — create-charge, capture, refund, status-mapping, with mocked
  HTTP (success + error + timeout + malformed payload).
- `registry.ts` — provider selection by tenant config.

### 3.8 Webhooks (`routes/webhooks.ts`, `lib/webhook-verify.ts`, jobs)
- signature verification (stripe + vps) — valid, invalid, missing, replayed.
- idempotency/duplicate detection; unknown event; provider mismatch; DB-throw during
  lookup returns 401 (not 500) — regression already covered.

### 3.9 Admin & ops (`routes/admin.ts`, `routes/apiKeys.ts`, `routes/exports.ts`, `routes/dashboard.ts`, `routes/simulation.ts`)
- tenant CRUD + status transitions; provider health checks; payment search.
- API key create (rawKey shown once) / list / revoke.
- CSV export shape; dashboard summary (today/week totals + payout status).
- simulation prepare/poll/delete (billing + installment).

### 3.10 Cross-cutting
- rate limiting (auth/checkout/api limiters) returns 429.
- security headers + CORS.
- global error handler shape (`{ error, code }`); 404 handler.

---

## 4. Test infrastructure

- **Test DB**: Postgres via `docker compose` (already present); CI uses the service
  container. `DATABASE_URL` points at an isolated test schema per run.
- **Factories**: `tests/factories.ts` — `makeTenant`, `makeUser`, `makeProviderConfig`,
  `makePaymentLink`, `makePaymentIntent`, `makeTransaction`, `makeSubscription`, …
  so tests express *intent* (state + a few fields) without hand-building rows.
- **HTTP mocking**: `nock` (or a transport seam) for stripe/vps/NAPS HTTP calls.
- **Provider seam**: `fake.adapter` drives deterministic E2E flows with no network.
- **Isolation**: truncate-between-tests (or transaction rollback) to keep tests independent.
- **Auth helpers**: `signToken(user)` to mint tokens for RBAC/tenant-isolation tests.

---

## 5. Coverage & CI

- Per-router coverage thresholds (calibrated from measured baselines, per the existing
  `vitest.config.ts` pattern) — money/billing/encryption/status-maps target **100%**.
- CI: existing `test` + `coverage` jobs absorb the new suites; add an `e2e` job if the
  full-flow suite grows slow.
- `knip` keeps the new seed/helpers from drifting into dead code.

---

## 6. Build phases (suggested order)

1. **Harness** — test DB wiring, `tests/factories.ts`, auth helpers, truncation.
2. **Demo seed** — `seed-demo-data.ts` + `seed-demo.ts` + `reset-demo.ts` + scripts.
3. **Unit + property** — close out money/billing/dunning/encryption (highest risk, pure).
4. **Integration** — one file per router against the demo tenant.
5. **E2E flows** — checkout → pay → webhook → refund; subscription lifecycle;
   installment lifecycle; RBAC + tenant isolation.
6. **CI + coverage** — thresholds, jobs, and a `docs/testing/` walkthrough.
