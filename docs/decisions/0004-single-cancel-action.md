# 4. Single "cancel" action for subscriptions and installment agreements

- Status: Accepted
- Date: 2026-08-22

## Context

Earlier plans distinguished "deactivate" from "archive" for recurring/BNPL
records, leading to ambiguous UI and multiple terminal states.

## Decision

- There is a single terminal action: **cancel**, represented by the `CANCELLED`
  value in `SubscriptionStatus` and `InstallmentAgreementStatus`.

## Consequences

- No `DEACTIVATED`/`ARCHIVED` states exist for these records.
- Audit entries use `SUBSCRIPTION_CANCELED` / `INSTALLMENT_AGREEMENT_CANCELLED`.
