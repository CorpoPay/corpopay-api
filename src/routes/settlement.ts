import { Router } from "express";

import { getSettlementSummary } from "../lib/settlement-summary-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── GET /settlement/summary ─────────────────────────────────────────────────────

// The tenant's net-owed position: how much CorpoPay still owes after commission,
// fees, reserve and reversals, plus the configured payout rail (`manual` vs
// `stripe_connect`) and the full fee/reserve/paid-out breakdown.
router.get(
  "/summary",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { summary, payoutRail } = await getSettlementSummary(req.user!.tenantId);
    res.json({
      currency: "MAD",
      availableCents: summary.availableCents,
      scheduledCents: summary.scheduledCents,
      eligibleCents: summary.eligibleCents,
      feesCents: summary.feesCents,
      reserveCents: summary.reserveCents,
      paidOutCents: summary.paidOutCents,
      payoutRail,
    });
  }),
);

export default router;
