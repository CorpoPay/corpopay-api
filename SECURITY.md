# Security Policy

CorpoPay processes payments, so we take security seriously. This document tells
you how to report a vulnerability and what to expect.

## Supported versions

| Version | Supported                        |
| ------- | -------------------------------- |
| `main`  | :white_check_mark:               |
| `dev`   | :white_check_mark: (pre-release) |

## Reporting a vulnerability

**Do not open a public issue** for a security vulnerability.

- **Preferred:** use GitHub's private vulnerability reporting —
  **Security → Report a vulnerability** on the repository. This lets you
  disclose privately and track the fix.
- **Alternative:** email `security@corpopay.site`.

Please include:

1. A clear description of the vulnerability and its impact.
2. Steps to reproduce, or a proof-of-concept if you have one.
3. The affected version(s) / branch.
4. Any suggested fix.

## What to expect

- We acknowledge reports within **72 hours**.
- We'll confirm the issue, assess severity, and agree on a fix timeline.
- We'll request a CVE where appropriate and credit you in the release notes
  (unless you prefer to stay anonymous).

## Scope

In scope: anything in the CorpoPay application code that can compromise a
tenant's data, payment flow, webhook verification, or authentication.

Out of scope: social-engineering attacks, missing SPF/DKIM/DMARC on email,
and issues in third-party providers (Stripe, VPS/Payzone, NAPS, Inngest)
that must be fixed upstream.

This is a best-effort program; CorpoPay does not currently offer a paid bug
bounty.
