# 2. Payment link `title` → `description`, `maxUses` → `maxAttempts`

- Status: Accepted
- Date: 2026-08-22

## Context

The web's payment-link create payload drifted from the API contract, sending
`title` and `maxUses` while the API (and the Prisma `PaymentLink` model) uses
`description` and `maxAttempts`.

## Decision

- The payment-link display field is `description` (not `title`).
- The capture/retry limit field is `maxAttempts` (not `maxUses`).

## Consequences

- The web payment-link form and the API contract agree; invalid payloads are
  rejected instead of silently ignored.
