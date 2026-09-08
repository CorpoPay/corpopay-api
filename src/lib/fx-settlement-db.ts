/**
 * FX settlement persistence (ADR 0006, phase 4).
 *
 * `convertForeignBalancesToSettlement` sweeps a tenant's non-settlement
 * `AVAILABLE` balances into their `settlementCurrency` before a payout snapshot.
 * For each foreign balance it quotes a locked rate and posts the conversion
 * (foreign AVAILABLE → settlement AVAILABLE) plus the explicit `FX_ADJUSTMENT`
 * gain/loss (see `fx-settlement.ts`). It is called inside the payout transaction
 * (advisory lock already held) so the sweep is atomic with the snapshot.
 */
import type { Prisma } from "@/generated/prisma/client";

import { quoteFx } from "./fx";
import { planFxConversion } from "./fx-settlement";
import { accountBalanceCents, postEntry } from "./ledger-db";
import { type Centimes, type Currency, SUPPORTED_CURRENCIES } from "./money";

export interface ConvertedBalanceSummary {
  from: Currency;
  to: Currency;
  amountFromMinor: Centimes;
  amountToMinor: Centimes;
  gainLossMinor: Centimes;
  rate: string;
  source: string;
}

/**
 * Convert every non-settlement `AVAILABLE` balance into `settlementCurrency`.
 *
 * Idempotent in practice: once a foreign balance is drained to zero it is skipped
 * on subsequent calls. The locked rate is quoted fresh per sweep; in the default
 * (sandbox) provider the locked rate equals the reference rate, so the
 * `FX_ADJUSTMENT` gain/loss is zero — the non-zero path is exercised by the
 * unit/property tests and a dedicated DB test with an explicit spread.
 */
export async function convertForeignBalancesToSettlement(
  tx: Prisma.TransactionClient,
  tenantId: string,
  settlementCurrency: Currency,
): Promise<ConvertedBalanceSummary[]> {
  const summaries: ConvertedBalanceSummary[] = [];

  for (const from of SUPPORTED_CURRENCIES) {
    if (from === settlementCurrency) continue;

    const balance = await accountBalanceCents(tx, tenantId, "AVAILABLE", from);
    if (balance <= 0) continue;

    const quote = await quoteFx(from, settlementCurrency);
    const plan = planFxConversion({
      from,
      to: settlementCurrency,
      amountFromMinor: balance,
      lockedRate: quote.rate,
      referenceRate: quote.rate,
    });

    for (const p of plan.postings) {
      await postEntry(tenantId, p, tx);
    }

    summaries.push({
      from,
      to: settlementCurrency,
      amountFromMinor: plan.amountFromMinor,
      amountToMinor: plan.amountToMinor,
      gainLossMinor: plan.gainLossMinor,
      rate: quote.rate,
      source: quote.source,
    });
  }

  return summaries;
}
