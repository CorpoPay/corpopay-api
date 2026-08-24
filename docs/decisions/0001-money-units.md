# 1. Money units: centimes in requests, MAD decimal in the DB

- Status: Accepted
- Date: 2026-08-22

## Context

Payment amounts flow through three layers with different representations. During
the axios→openapi-fetch migration the web sent MAD where the API expected
centimes, producing links that were 1/100th the intended amount.

## Decision

- **API request payloads** use **centimes** as integers (e.g. `amount: 125000` = 1 250.00 MAD).
- **Database** stores **MAD** as `Decimal(12, 2)`.
- **API responses** return `number | string | null` (Prisma `Decimal` serializes to a string; handlers that call `Number()` emit numbers; absent amounts are `null`).

## Consequences

- Requests and the DB are decoupled from the display currency's decimal form.
- Any code touching money must convert exactly once; never double-multiply.
- The web coerces the generated `number | string | unknown` type with `toMoney()`
  in `corpopay-web/lib/money.ts`.
