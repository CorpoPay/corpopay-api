import { Router } from "express";

import { getTenantLedger } from "../lib/ledger-db";
import { type Currency, centimesToMad, fromMinor } from "../lib/money";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── GET /ledger ─────────────────────────────────────────────────────────────────

// Tenant-scoped settlement ledger: derived per-account balances, the global
// double-entry invariant, and the immutable entries behind them. Read-only — the
// write path (capture/refund/payout) lands with the payout engine.
//
// Multi-currency (ADR 0006): `balancesByCurrency` is the authoritative
// per-(account, currency) view; `balances` remains the MAD projection for
// backward-compatible consumers. Each entry carries its ISO 4217 `currency`.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const view = await getTenantLedger(req.user!.tenantId);

    res.json({
      balanced: view.balanced,
      balances: Object.fromEntries(
        Object.entries(view.balances).map(([account, cents]) => [account, centimesToMad(cents)]),
      ),
      balancesByCurrency: Object.fromEntries(
        Object.entries(view.balancesByCurrency).map(([currency, accounts]) => [
          currency,
          Object.fromEntries(
            Object.entries(accounts).map(([account, cents]) => [
              account,
              fromMinor(cents, currency as Currency),
            ]),
          ),
        ]),
      ),
      entries: view.entries.map((entry) => ({
        id: entry.id,
        postingId: entry.postingId,
        account: entry.account,
        direction: entry.direction,
        category: entry.category,
        currency: entry.currency,
        amount: fromMinor(entry.amountCents, entry.currency),
        balanceAfter: fromMinor(entry.balanceAfterCents, entry.currency),
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        createdAt: entry.createdAt,
      })),
    });
  }),
);

export default router;
