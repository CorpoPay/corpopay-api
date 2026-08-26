/**
 * Fee engine (PayFac settlement) — pure, centime-exact math.
 *
 * Computes a CorpoPay fee from a `FeeSchedule` (the "fee model" dimension of a
 * settlement policy). Four fee types are supported, all computed in integer
 * centimes so rounding is explicit and never accumulates floating-point error:
 *
 *   FLAT        — a fixed amount per transaction.
 *   PERCENTAGE  — a basis-point rate of the transaction amount.
 *   PER_METHOD  — a fixed amount keyed by payment method (card / bank / …).
 *   TIERED      — a bracket rate: the first tier whose `upToCents` covers the
 *                 amount wins; the last tier is the catch-all.
 *
 * Basis points are integer tenths-of-a-percent: 290 = 2.9%. Percentage fees are
 * rounded to the nearest centime (round half away from zero) — the single place
 * where a fraction of a centime can arise, and therefore the single place the
 * rounding rule lives.
 *
 * Everything here is pure and side-effect-free. Persistence (fee-schedule CRUD)
 * lives in `fees-db.ts` and converts DB rows into the `FeeScheduleSpec` shape
 * consumed here.
 */
import type { FeeType } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

/** Basis points per whole unit (100% = 10_000 bps). */
const BPS_PER_UNIT = 10_000;

export interface FeeTier {
  /** Inclusive upper bound (centimes) for this bracket. */
  upToCents: number;
  /** Basis-point rate applied to amounts in this bracket. */
  percentageBps: number;
}

/**
 * The normalized shape of a fee schedule, independent of the Prisma `Json`
 * columns that carry `perMethodCents` and `tiersCents`. `fees-db.ts` builds
 * this from a `FeeSchedule` row; presets and tests build it directly.
 */
export interface FeeScheduleSpec {
  feeType: FeeType;
  flatCents: number | null;
  percentageBps: number | null;
  perMethodCents: Record<string, number> | null;
  tiersCents: FeeTier[] | null;
}

export class FeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeError";
  }
}

/** Apply a basis-point rate to a centime amount, rounded to the nearest centime. */
export function applyBps(amountCents: number, bps: number): Centimes {
  if (bps < 0) throw new FeeError("bps must be non-negative");
  return centimes(Math.round((amountCents * bps) / BPS_PER_UNIT));
}

/** Percentage fee from a basis-point rate. */
function percentFee(amountCents: number, bps: number): Centimes {
  return applyBps(amountCents, bps);
}

/**
 * Compute the fee (centimes) for a transaction amount.
 *
 * @param schedule  the fee schedule (flat / percentage / per-method / tiered)
 * @param amountCents  the gross transaction amount in centimes (non-negative)
 * @param method  payment method key (e.g. "card", "bank_transfer"); only used
 *                by PER_METHOD schedules
 */
export function computeFee(
  schedule: FeeScheduleSpec,
  amountCents: Centimes,
  method?: string,
): Centimes {
  if (amountCents < 0) throw new FeeError("amount must be non-negative");

  switch (schedule.feeType) {
    case "FLAT": {
      const flat = schedule.flatCents ?? 0;
      if (flat < 0) throw new FeeError("flatCents must be non-negative");
      return centimes(flat);
    }
    case "PERCENTAGE": {
      return percentFee(amountCents, schedule.percentageBps ?? 0);
    }
    case "PER_METHOD": {
      const perMethod = schedule.perMethodCents ?? {};
      const flat = method != null ? (perMethod[method] ?? 0) : 0;
      if (flat < 0) throw new FeeError("per-method fee must be non-negative");
      return centimes(flat);
    }
    case "TIERED": {
      const tiers = schedule.tiersCents ?? [];
      const tier = tiers.find((t) => amountCents <= t.upToCents) ?? tiers[tiers.length - 1];
      return tier ? percentFee(amountCents, tier.percentageBps) : centimes(0);
    }
  }
}

/**
 * Gross → net: the amount left after the fee. `net = gross − fee`. Negative net
 * is allowed (a flat fee can exceed a tiny gross) and is the caller's concern.
 */
export function netAfterFee(
  schedule: FeeScheduleSpec,
  amountCents: Centimes,
  method?: string,
): Centimes {
  return centimes(amountCents - computeFee(schedule, amountCents, method));
}
