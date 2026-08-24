import { Router } from "express";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { centimes, centimesToMad } from "../lib/money";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";

const router = Router();

// ─── GET /dashboard/summary ────────────────────────────────────────────────────────
// Aggregates merchant sales for today and the current week.
// Returns count + total for SUCCEEDED payment intents.
//
// Amount resolution mirrors /transactions:
//   - PaymentLink intents: paymentLink.amount (stored as MAD decimal)
//   - Direct intents:      metadata.amount (stored as centimes)

router.get(
  "/summary",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const now = new Date();

    // Start of today (UTC — consistent with createdAt storage)
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);

    // Start of the current week (Monday)
    const startOfWeek = new Date(startOfToday);
    const day = startOfWeek.getUTCDay(); // 0 = Sunday
    const diffToMonday = day === 0 ? 6 : day - 1;
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - diffToMonday);

    // Fetch SUCCEEDED intents since start of week (covers both today + week).
    // We avoid two separate queries by fetching the week window once.
    const intents = await db.paymentIntent.findMany({
      where: {
        status: "SUCCEEDED",
        createdAt: { gte: startOfWeek },
      },
      select: {
        createdAt: true,
        paymentLink: { select: { amount: true, currency: true } },
        metadata: true,
      },
    });

    let todayCount = 0;
    let todayTotal = 0;
    let weekCount = 0;
    let weekTotal = 0;
    let currency = "MAD";

    for (const intent of intents) {
      // Resolve amount in MAD
      const meta = (intent.metadata ?? {}) as Record<string, unknown>;
      const amountMAD = intent.paymentLink?.amount
        ? Number(intent.paymentLink.amount)
        : meta.amount != null
          ? centimesToMad(centimes(Number(meta.amount))) // centimes → MAD
          : 0;

      if (intent.paymentLink?.currency) {
        currency = intent.paymentLink.currency;
      } else if (meta.currency) {
        currency = String(meta.currency);
      }

      weekCount += 1;
      weekTotal += amountMAD;

      if (intent.createdAt >= startOfToday) {
        todayCount += 1;
        todayTotal += amountMAD;
      }
    }

    // Round to 2 decimal places to avoid floating-point noise
    const round = (n: number) => Math.round(n * 100) / 100;

    res.json({
      today: {
        count: todayCount,
        total: round(todayTotal),
        currency,
      },
      thisWeek: {
        count: weekCount,
        total: round(weekTotal),
        currency,
      },
      // Payout status is a placeholder until the sub-merchant / referral
      // settlement model is implemented on the CorpoPay side.
      payoutStatus: "NOT_APPLICABLE",
    });
  }),
);

export default router;
