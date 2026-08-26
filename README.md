# CorpoPay API

Multi-tenant payment orchestration API — **Express + Prisma + Inngest**, deployable
to AWS Lambda (or any Node host). Providers: **VPS/Payzone** (full), **Stripe**
(full), and **NAPS** (skeleton), plus recurring billing (subscriptions) and BNPL
(installments).

## Features

- **Multi-tenancy** — tenants are fully isolated; every tenant-scoped query filters
  by `tenantId` taken from the authenticated user, never from a client-supplied value.
- **Hosted payment links** and a **server-to-server API** (`/payment-intents`).
- **Provider adapters** behind a single `ProviderAdapter` interface
  (`src/adapters/`) — add a PSP without touching any route.
- **Recurring billing** (subscriptions, dunning) and **BNPL installments**.
- **PayFac settlement** — a double-entry money ledger (7 accounts), per-tenant fee
  schedules + settlement policies, payouts, and chargeback/reversal clawback with
  recoveries.
- **Webhooks** with synchronous signature verification and idempotent dedup.
- **Generated OpenAPI contract** (`src/openapi.ts`) — the single source of truth
  shared with the web app.

## Quick start

Prerequisites: Node 24+, Docker.

```bash
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, …
docker compose up --build   # API :4000 · Inngest dev server :8288
```

`docker compose up` runs migrations and the seed automatically. See
[`.env.example`](.env.example) for the full list of variables.

### Without Docker

```bash
npm install
npx prisma migrate dev
npm run dev     # :4000
```

### Verify

```bash
npm run typecheck
npm run lint
npm run test
```

## Environment variables

| Variable                                        | Description                                  |
| ----------------------------------------------- | -------------------------------------------- |
| `DATABASE_URL`                                  | PostgreSQL connection string (pooled)        |
| `DIRECT_URL`                                    | Direct connection string (migrations only)   |
| `JWT_SECRET` / `JWT_EXPIRES_IN`                 | Auth signing secret + token expiry           |
| `ENCRYPTION_KEY`                                | 64-char hex (32 bytes) — AES-256-GCM         |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`     | Inngest event + signing keys                 |
| `API_BASE_URL` / `WEB_BASE_URL`                 | Public URLs (callbacks, checkout links)      |
| `NOTIFICATION_SQS_QUEUE_URL` _(optional)_       | SQS queue for outbound payment notifications |
| `DD_API_KEY` / `METRICS_BASE_TAGS` _(optional)_ | Enables Datadog custom metrics + base tags   |

Secrets come from environment variables only — never hardcode them.

## Money & statuses

- **Money** — requests are **centimes** (int); the database stores **MAD**
  `Decimal(12,2)`; responses are `number | string | null`. Convert **only** via
  `src/lib/money.ts`. Never write a bare `/ 100` or `* 100`.
- **Statuses** — Prisma enums are the single source of truth. `CANCELLED`
  (provider/webhook) and `CANCELED` (`PaymentIntentStatus`) are both real and
  different — do not collapse them. Provider→internal mapping lives in
  `src/lib/status-maps.ts`.

## API routes

### Public

| Method | Path                              | Description        |
| ------ | --------------------------------- | ------------------ |
| `GET`  | `/health`                         | Health check       |
| `GET`  | `/public/checkout/:slug`          | Fetch payment link |
| `POST` | `/public/checkout/:slug/pay`      | Initiate payment   |
| `GET`  | `/public/installment-plans/:slug` | BNPL plan preview  |
| `GET`  | `/public/pay/:correlationId`      | Paywall relay page |

### Webhooks

| Method | Path               |
| ------ | ------------------ |
| `POST` | `/webhooks/naps`   |
| `POST` | `/webhooks/vps`    |
| `POST` | `/webhooks/stripe` |
| `POST` | `/api/inngest`     |

### Auth

| Method | Path                    |
| ------ | ----------------------- |
| `POST` | `/auth/register`        |
| `POST` | `/auth/login`           |
| `GET`  | `/auth/me`              |
| `POST` | `/auth/forgot-password` |
| `POST` | `/auth/reset-password`  |

### Merchant (JWT / API key)

| Method                  | Path                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `GET/PATCH`             | `/tenant`                                                                    |
| `GET/POST`              | `/users` (+ `POST /invite`, `PATCH /:id/role`, `DELETE /:id`)                |
| `GET/POST`              | `/provider-configs` (+ `POST /:id/test`, `PATCH /:id/status`, `DELETE /:id`) |
| `GET/POST`              | `/payment-links` (+ `GET /:id`, `PATCH /:id/cancel`)                         |
| `POST`                  | `/payment-intents` (+ `GET /:id`, capture/cancel/status)                     |
| `GET`                   | `/transactions`, `/transactions/:id`                                         |
| `POST`                  | `/transactions/:id/refund`                                                   |
| `GET`                   | `/dashboard/summary`                                                         |
| `GET`                   | `/exports/transactions.csv`                                                  |
| `GET/POST`              | `/api-keys` (+ `DELETE /:id`)                                                |
| `GET`                   | `/subscriptions` (+ pause/resume/cancel/events)                              |
| `GET/POST/PATCH/DELETE` | `/installment-plans`                                                         |
| `GET`                   | `/installment-agreements` (+ `POST /:id/cancel`)                             |

### Settlement (PayFac money movement — `OWNER`)

| Method     | Path                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `GET`      | `/ledger`                                                                  |
| `GET/POST` | `/fee-schedules` (+ `GET /active`)                                          |
| `GET/POST` | `/settlement-policies` (+ `GET /active`)                                    |
| `GET/POST` | `/payouts` (+ `GET /:id`, `POST /:id/cancel`, `POST /:id/process`)         |
| `GET/POST` | `/disputes` (+ `GET /:id`, `POST /:id/resolve`)                             |

### Admin (`SUPPORT_ADMIN` / `SUPER_ADMIN`)

| Method     | Path                                   |
| ---------- | -------------------------------------- |
| `GET`      | `/admin/tenants`, `/admin/tenants/:id` |
| `PATCH`    | `/admin/tenants/:id/status`            |
| `GET`      | `/admin/payments/search`               |
| `GET`      | `/admin/webhooks`                      |
| `GET/PUT`  | `/admin/provider-health`               |
| `GET/POST` | `/admin/simulation`                    |

## Tech stack

| Layer           | Technology                               |
| --------------- | ---------------------------------------- |
| Runtime         | Node.js 24, Express, `serverless-http`   |
| ORM             | Prisma 7 + PostgreSQL                    |
| Background jobs | Inngest                                  |
| Auth            | JWT (jsonwebtoken), bcryptjs             |
| Encryption      | AES-256-GCM (Node crypto)                |
| Deploy          | Docker Compose, or AWS Lambda (optional) |

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
