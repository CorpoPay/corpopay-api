# 3. Tenant status `SUSPENDED` → `DISABLED`

- Status: Accepted
- Date: 2026-08-22

## Context

The web rendered tenant status `SUSPENDED`, which the API rejects. The Prisma
`TenantStatus` enum is `ACTIVE | DISABLED`.

## Decision

- The tenant status value is `DISABLED` (not `SUSPENDED`).

## Consequences

- Tenant enable/disable actions use the `DISABLED` value.
- Statuses are centralized in `corpopay-web/lib/status.ts`.
