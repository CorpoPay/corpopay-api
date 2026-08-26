import { Router } from "express";

import { getTenantLedger } from "../lib/ledger-db";
import { centimesToMad } from "../lib/money";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── GET /ledger ─────────────────────────────────────────────────────────────────

// Tenant-scoped settlement ledger: derived per-account balances (MAD), the global
// double-entry invariant, and the immutable entries behind them. Read-only — the
// write path (capture/refund/payout) lands with the payout engine.
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
      entries: view.entries.map((entry) => ({
        id: entry.id,
        postingId: entry.postingId,
        account: entry.account,
        direction: entry.direction,
        category: entry.category,
        amount: centimesToMad(entry.amountCents),
        balanceAfter: centimesToMad(entry.balanceAfterCents),
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        createdAt: entry.createdAt,
      })),
    });
  }),
);

export default router;
