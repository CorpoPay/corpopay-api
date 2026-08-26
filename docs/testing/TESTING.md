# CorpoPay API — Testing & Demo Seed Walkthrough

This walkthrough documents the two deliverables introduced by
[`DEMO_SEED_AND_TEST_PLAN.md`](./DEMO_SEED_AND_TEST_PLAN.md): the **generic demo
seed** and the **full test suite**. It tells you how to run them, how the test
harness is wired, and where the deliberate coverage boundaries are.

---

## Money invariant (read this first)

The database stores **MAD** as `Decimal(12,2)`; the API boundary and provider
adapters speak **centimes** (integer). Every conversion goes through
`src/lib/money.ts` — never by hand. All amount-related tests assert centime
exactness. See [`docs/decisions/0001-money-units.md`](../decisions/0001-money-units.md)
for the rationale.

---

## Demo seed

Three files, one deterministic tenant:

| File | Purpose |
|---|---|
| `prisma/seed-demo-data.ts` | Typed fixture factory — the single source of demo data (fixed IDs/slugs/`correlationId`s, fixed date offsets, no `Math.random()`/`Date.now()`). |
| `prisma/seed-demo.ts` | Idempotent seeder — upserts the whole demo graph by stable key. Safe to run repeatedly. |
| `prisma/reset-demo.ts` | FK-safe truncate of the demo tenant + re-seed. Used by demos/E2E for a clean slate. |

The seed creates a single `demo` tenant (`slug: "demo"`, `environment: "test"`,
`status: "active"`) exercising every entity and lifecycle state: three users
(admin/owner/viewer), three provider configs (`fake`, `stripe`, `vps`), payment
links (one-time/recurring/installment/expired/cancelled), payment intents in
every terminal state, transactions + refunds, subscriptions (`active`/`past_due`/
`cancelled`) with billing events, an installment plan + agreement + mixed-state
charges, active + revoked API keys, and verified/unverified/duplicate webhook
events.

```bash
# Requires ENCRYPTION_KEY (64 hex chars) and DATABASE_URL, same as prisma/seed.ts.
npm run db:seed:demo
npm run db:reset:demo   # truncate demo tenant + re-seed
```

---

## Sandbox seed (multi-tenant)

`prisma/seed-sandbox.ts` builds a richer **multi-tenant** dataset for local dev
and end-to-end tests. It reuses the `demo` graph and adds two realistic tenants —
`otoparking` (parking) and `jabadoor` (retail) — each exercising the full
lifecycle (users, providers, links, intents, refunds, subscriptions, installment
plans, API keys, webhook events).

| File | Purpose |
|---|---|
| `prisma/seed-sandbox.ts` | Idempotent multi-tenant seeder (demo + otoparking + jabadoor). |
| `prisma/reset-sandbox.ts` | FK-safe truncate of all sandbox tenants + re-seed. |

```bash
npm run db:seed:sandbox   # demo + otoparking + jabadoor
npm run db:reset:sandbox  # truncate all sandbox tenants + re-seed
```

`docker compose up` runs both `prisma/seed.ts` (master: internal admin, provider
health, Acme sample) and `prisma/seed-sandbox.ts`, so the local Postgres is fully
seeded. All sandbox credentials are `demo-*` / `<slug>-*` placeholders — never
real PSP keys.

---

## Test pyramid

| Layer | Scope | Location | Fast? |
|---|---|---|---|
| Unit | `lib/` pure logic (money, billing, dunning, encryption, webhook-verify, status-maps, env, mask) | `src/lib/*.test.ts`, `src/middleware/*.test.ts` | ✅ in-memory |
| Property | money & billing rounding, fee math, installment schedules | `src/lib/*.property.test.ts` (fast-check) | ✅ |
| Provider | stripe/naps/vps adapters with mocked HTTP | `src/adapters/*.test.ts` | ✅ |
| Jobs | billing/dunning/installment/webhook jobs (Inngest) | `src/jobs/*.inngest.test.ts` | ✅ |
| Integration | one file per router, real routes, mocked Prisma | `tests/integration/*.routes.test.ts` | ✅ (no DB) |
| E2E flow | full lifecycle across routes + providers + webhooks | `tests/e2e/*.test.ts` | ✅ (no DB) |

All layers run **without a database or network** — Prisma is mocked
(`tests/helpers/mock-prisma.ts`), Inngest is mocked where a route sends events,
and the `fake` adapter drives deterministic flows.

```bash
npm test                # vitest run (fast, no DB)
npm run test:coverage   # vitest run --coverage (enforces thresholds)
npm run test:watch      # vitest (watch mode)
```

---

## Test harness

- **`tests/helpers/setup-env.ts`** — global test env (`NODE_ENV=test`,
  `JWT_SECRET`, `ENCRYPTION_KEY`, …), loaded by `vitest` `setupFiles`. Test-only
  constants, no secrets.
- **`tests/helpers/mock-prisma.ts`** — builds a full mock Prisma client whose
  `$extends` returns itself, so `forTenant()` and raw `prisma` share one object.
- **`tests/factories.ts`** — pure `makeX(overrides?)` builders for every entity +
  `mintToken(user)` for RBAC/tenant-isolation auth. Amounts are MAD numbers;
  convert through `src/lib/money.ts` when a test needs centimes.

---

## Coverage

Thresholds live in `vitest.config.ts`. The **pure money/billing/encryption/
status-maps** helpers (plus `mask`, `webhook-verify`, and `validateEnv`) are
gated at **100% line coverage**. `dunning` and each router are gated at a
calibrated baseline measured from the suite (with a small buffer so coverage
stays green while suites grow). Run `npm run test:coverage` to see the per-file
table and any threshold failures.

---

## Known coverage boundaries (deliberate)

- **`src/routes/simulation.ts`** — the `/admin/simulation/*` endpoints are
  demo-oriented and drive live VPS polling, so they are exercised through the
  demo seed and a manual demo rather than automated integration tests. They are
  intentionally excluded from the coverage gate.
- **`express-rate-limit` middleware** — `authLimiter`/`checkoutLimiter`/
  `apiLimiter` are `skip`-ped when `NODE_ENV === "test"`, so the third-party 429
  path isn't unit-tested. The app-level `MAX_ATTEMPTS` 429 (business rule) **is**
  covered in `tests/integration/paymentIntents.routes.test.ts`.

---

## Cross-cutting middleware (§3.10)

`tests/integration/crosscutting.routes.test.ts` proves the app-wide glue:
Helmet security headers, the dashboard-origin CORS preflight, and the canonical
`{ error, code }` 404 shape. `src/middleware/errorHandler.test.ts` unit-tests the
global error handler (`AppError` → status+code, `ZodError` → 422
`VALIDATION_ERROR`, unknown → 500 `INTERNAL_ERROR`).
