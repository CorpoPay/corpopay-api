/**
 * Split engine (PayFac settlement) — pure, centime-exact math.
 *
 * A split divides a source amount into **beneficiary** shares (sub-merchants,
 * vendors, hosts, lot owners…) plus a **platform remainder** retained by the
 * tenant. The source account is determined by the rule's trigger:
 *
 *   AT_CAPTURE      — the source is a fresh capture sitting in COLLECTED.
 *   ON_USAGE/MANUAL — the source is a slice of the tenant's AVAILABLE balance
 *                     (the prepaid-wallet "pay-as-you-use" pattern).
 *
 * Each beneficiary share is credited to that party's AVAILABLE (immediate) or
 * RESERVE (held/escrow) account, tagged with `partyId`. The platform remainder
 * stays with the tenant: AT_CAPTURE moves it COLLECTED → AVAILABLE; ON_USAGE
 * leaves it in place. The sum of every share plus the platform remainder always
 * equals the source — the centime-exact invariant that makes this
 * property-testable. Persistence + the ledger postings live in `splits-db.ts`.
 *
 * Amounts cross this boundary as integer centimes.
 */
import type { SplitStatus, SplitTrigger } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";

export const SPLIT_TRIGGERS = ["AT_CAPTURE", "ON_USAGE", "MANUAL"] as const;
export const SPLIT_STATUSES = ["PENDING", "SETTLED", "REVERSED"] as const;

/** One beneficiary's share, expressed in basis points (10 000 = 100%). */
export interface ShareSpec {
  partyId: string;
  shareBps: number;
}

/** A concrete centime allocation for one beneficiary. */
export interface ShareAllocation {
  partyId: string;
  amountCents: Centimes;
}

/** The full result of dividing a source: beneficiary shares + platform remainder. */
export interface SplitResult {
  shares: ShareAllocation[];
  platformCents: Centimes;
}

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

/** Allowed outgoing transitions per split status (terminal states have none). */
const TRANSITIONS: Record<SplitStatus, readonly SplitStatus[]> = {
  PENDING: ["SETTLED", "REVERSED"],
  SETTLED: [],
  REVERSED: [],
};

export function canTransition(from: SplitStatus, to: SplitStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SplitStatus, to: SplitStatus): void {
  if (!canTransition(from, to)) {
    throw new SplitError(`illegal split transition ${from} -> ${to}`);
  }
}

/** The ledger account a split debits (the source of the money being divided). */
export function sourceAccountFor(trigger: SplitTrigger): "COLLECTED" | "AVAILABLE" {
  return trigger === "AT_CAPTURE" ? "COLLECTED" : "AVAILABLE";
}

/**
 * Validate a beneficiary share list: at least one strictly-positive share, every
 * share an integer number of basis points in (0, 10 000], and the total at most
 * 10 000 (the platform keeps the remainder).
 */
export function validateShares(shares: readonly ShareSpec[]): void {
  if (shares.length === 0) throw new SplitError("at least one beneficiary share is required");
  for (const share of shares) {
    if (!Number.isInteger(share.shareBps) || share.shareBps <= 0 || share.shareBps > 10_000) {
      throw new SplitError(`invalid shareBps ${share.shareBps} for party ${share.partyId}`);
    }
  }
  const total = shares.reduce((sum, share) => sum + share.shareBps, 0);
  if (total > 10_000) {
    throw new SplitError(`beneficiary shares sum to ${total} bps (max 10 000)`);
  }
}

/**
 * Divide `totalCents` among `shares` in proportion to `shareBps`, using
 * largest-remainder so the allocation is centime-exact (Σ = `totalCents`) and no
 * beneficiary is off its ideal by more than one centime.
 */
export function computeShares(
  totalCents: Centimes,
  shares: readonly ShareSpec[],
): ShareAllocation[] {
  if (totalCents < 0) throw new SplitError("total must be non-negative");
  validateShares(shares);

  const totalBps = shares.reduce((sum, share) => sum + share.shareBps, 0);
  const parts = shares.map((share) => {
    const exact = (totalCents * share.shareBps) / totalBps;
    const floor = Math.floor(exact);
    return { partyId: share.partyId, floor, frac: exact - floor };
  });

  let remaining = totalCents - parts.reduce((sum, part) => sum + part.floor, 0);
  const order = [...parts].sort((a, b) => b.frac - a.frac || a.partyId.localeCompare(b.partyId));
  let index = 0;
  while (remaining > 0) {
    order[index % order.length].floor += 1;
    remaining -= 1;
    index += 1;
  }

  return parts.map((part) => ({ partyId: part.partyId, amountCents: centimes(part.floor) }));
}

/** The platform remainder: source minus the beneficiary total (always ≥ 0, exact). */
export function platformShareCents(
  sourceCents: Centimes,
  allocations: readonly ShareAllocation[],
): Centimes {
  return centimes(sourceCents - allocations.reduce((sum, a) => sum + a.amountCents, 0));
}

/**
 * Divide a source into beneficiary shares + the platform remainder, such that
 * Σ beneficiary shares + platform remainder === source (the invariant).
 */
export function split(sourceCents: Centimes, shares: readonly ShareSpec[]): SplitResult {
  if (sourceCents < 0) throw new SplitError("source must be non-negative");
  validateShares(shares);
  const totalBps = shares.reduce((sum, share) => sum + share.shareBps, 0);
  const beneficiaryCents = centimes(Math.round((sourceCents * totalBps) / 10_000));
  const allocations = computeShares(beneficiaryCents, shares);
  return { shares: allocations, platformCents: platformShareCents(sourceCents, allocations) };
}
