/**
 * Risk scorer seam (cloud-agnostic) + RiskTier -> thresholds mapping.
 *
 * Enforcement (as opposed to the record-only `risk.ts` engine) is a pluggable
 * seam: OSS ships a deterministic DB-backed scorer — amount + tenant velocity,
 * tiered thresholds. A private fork (or a future ML service) can register its
 * own implementation via `setRiskScorer` without changing any call site.
 *
 * Money crosses this boundary as integer centimes only.
 */
import type { RiskTier } from "@/generated/prisma/client";

import { type Centimes, centimes } from "./money";
import { prisma } from "./prisma";
import {
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_VELOCITY_WINDOW_SECONDS,
  evaluateRisk,
  type RiskReason,
  type RiskThresholds,
  type RiskVerdict,
} from "./risk";

/** Per-tier thresholds. LOW is the most permissive, HIGH the strictest. */
export const RISK_TIER_THRESHOLDS: Record<RiskTier, RiskThresholds> = {
  LOW: { maxAmountCents: centimes(10_000_000), maxPerWindow: 200 },
  MEDIUM: DEFAULT_RISK_THRESHOLDS,
  HIGH: { maxAmountCents: centimes(100_000), maxPerWindow: 5 },
};

export function thresholdsForTier(tier: RiskTier | null | undefined): RiskThresholds {
  return RISK_TIER_THRESHOLDS[tier ?? "MEDIUM"];
}

export interface ScoreRiskInput {
  tenantId: string;
  amountCents: Centimes;
  occurredAt?: Date;
}

export interface ScoreRiskResult {
  verdict: RiskVerdict;
  score: number;
  reasons: RiskReason[];
}

export type RiskScorer = (input: ScoreRiskInput) => Promise<ScoreRiskResult>;

let scorer: RiskScorer | null = null;

export function setRiskScorer(fn: RiskScorer): void {
  scorer = fn;
}

/** Restore the default DB-backed scorer (test seam). */
export function resetRiskScorer(): void {
  scorer = null;
}

export async function scoreRisk(input: ScoreRiskInput): Promise<ScoreRiskResult> {
  return (scorer ?? defaultRiskScorer)(input);
}

/**
 * Default scorer: tier thresholds + the tenant's recent intent count (velocity)
 * within the sliding window, evaluated through the pure `evaluateRisk` core.
 */
async function defaultRiskScorer(input: ScoreRiskInput): Promise<ScoreRiskResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const cutoff = new Date(occurredAt.getTime() - DEFAULT_VELOCITY_WINDOW_SECONDS * 1000);

  const [onboarding, velocityCount] = await Promise.all([
    prisma.merchantOnboarding.findUnique({
      where: { tenantId: input.tenantId },
      select: { riskTier: true },
    }),
    prisma.paymentIntent.count({
      where: { tenantId: input.tenantId, createdAt: { gte: cutoff } },
    }),
  ]);

  const thresholds = thresholdsForTier(onboarding?.riskTier);
  const { verdict, score, reasons } = evaluateRisk(input.amountCents, velocityCount, thresholds);
  return { verdict, score, reasons };
}
