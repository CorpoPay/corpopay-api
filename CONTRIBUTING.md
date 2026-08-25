# Contributing to CorpoPay

Thanks for contributing. CorpoPay is a multi-tenant payment orchestration
platform, so a few domain rules are non-negotiable — please read them before
opening a PR.

## Prerequisites

- **Node 24+**
- **Docker** (for the one-command dev stack) — or a local PostgreSQL 16
- `npm`

## Getting started

```bash
# From the repo root (API + Postgres + Inngest dev server)
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, ...
docker compose up --build   # API on :4000, Inngest on :8288
```

`docker compose up` runs Prisma migrations + seed automatically. Default seed
users are listed in the README.

## Before you submit

```bash
npm run prisma:generate   # generated client is gitignored
npm run typecheck
npm run lint
npm run test
```

## The rules that matter (payment domain)

These are the things reviewers will check first:

- **Money** — requests are **centimes** (int); the database stores **MAD**
  `Decimal(12,2)`; API responses are `number | string | null`. Convert **only**
  via `src/lib/money.ts`. Never write a bare `/ 100` or `* 100`.
- **Statuses** — Prisma enums are the single source of truth. `CANCELLED`
  (provider/webhook) and `CANCELED` (`PaymentIntentStatus`) are _both_ real and
  different — do not collapse them. Provider→internal mapping lives in
  `src/lib/status-maps.ts`.
- **Multi-tenancy** — every tenant-scoped query must filter by `tenantId` taken
  from `req.user`, never from a client-supplied value.
- **Webhooks** — verify the signature synchronously before any DB write, and
  dedupe on `WebhookEvent.idempotencyKey`.
- **Providers** — always go through the `ProviderAdapter` interface
  (`src/adapters/types.ts`) via `getAdapter()` (`src/adapters/registry.ts`).
  Never call a PSP directly from a route.
- **Secrets** — come from environment variables only (see `.env.example`).
  Never hardcode a secret or key.

## Adding or changing an endpoint

1. Edit the route in `src/routes/<resource>.ts` (validate with **Zod**, inline).
2. Declare request/response schemas in `src/openapi.ts` (reuse `Money` /
   `NullableMoney` / `Json` helpers).
3. Mount the router in `src/app.ts`.
4. Regenerate the contract:
   ```bash
   npm run contract:generate
   ```
   The web repo consumes the generated types via the published `@corpopay/contract` package.

## Pull request process

- Open a PR against `main` (or `dev` for pre-release work).
- Keep changes focused; add/update tests for new behavior.
- CI must be green (typecheck, lint, test, audit, coverage, and security scans).
- A maintainer will review; discussion is welcome, but the domain rules above
  are not optional.
