/**
 * Settlement-summary read view (Tier 2).
 *
 * Reads the tenant's ledger balances, sums the amount already reserved by open
 * payouts, and folds both into a pure `SettlementSummary`. Also resolves the
 * active policy's `payoutRail` so the caller knows whether the net-owed amount
 * is paid out manually (Morocco) or via Stripe Connect (international).
 */
import type { PayoutRail } from "@/generated/prisma/client";

import { getTenantLedger } from "./ledger-db";
import { type Centimes, centimes, madToCentimes } from "./money";
import { OPEN_PAYOUT_STATUSES } from "./payout";
import { getActiveSettlementPolicy } from "./policy-db";
import { prisma } from "./prisma";
import { computeSettlementSummary, type SettlementSummary } from "./settlement-summary";

export interface SettlementSummaryView {
  summary: SettlementSummary;
  payoutRail: PayoutRail | null;
}

/** Compute the tenant's net-owed settlement position + payout rail. */
export async function getSettlementSummary(tenantId: string): Promise<SettlementSummaryView> {
  const { balances } = await getTenantLedger(tenantId);
  const openPayouts = await prisma.payout.findMany({
    where: { tenantId, status: { in: [...OPEN_PAYOUT_STATUSES] } },
    select: { amount: true },
  });
  const scheduledCents = openPayouts.reduce((sum, payout) => sum + madToCentimes(payout.amount), 0);
  const summary = computeSettlementSummary(balances, centimes(scheduledCents));
  const policy = await getActiveSettlementPolicy(tenantId);
  return { summary, payoutRail: policy?.payoutRail ?? null };
}
