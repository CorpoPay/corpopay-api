/**
 * Risk persistence + the DB-backed velocity count.
 *
 * The pure engine (`risk.ts`) is side-effect-free and uses an in-memory velocity
 * store. In a serverless process that memory is gone between invocations, so the
 * production path counts *prior* risk decisions from Postgres within the sliding
 * window, then records the current decision (idempotent, upsert by `eventId`).
 *
 * Amounts cross this module's boundary as integer centimes.
 */
import type { Prisma, RiskDecision as RiskDecisionRecord } from "@/generated/prisma/client";

import type { Centimes } from "./money";
import { prisma } from "./prisma";
import {
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_VELOCITY_WINDOW_SECONDS,
  evaluateRisk,
  type RiskDecision,
  type RiskThresholds,
} from "./risk";

async function countRecentRiskDecisions(
  tenantId: string,
  now: Date,
  windowSeconds: number = DEFAULT_VELOCITY_WINDOW_SECONDS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowSeconds * 1000);
  return prisma.riskDecision.count({ where: { tenantId, createdAt: { gte: cutoff } } });
}

export interface EvaluateRiskInput {
  eventId: string;
  tenantId: string;
  amountCents: Centimes;
  occurredAt: Date;
  type?: string;
  thresholds?: RiskThresholds;
}

export interface EvaluateRiskResult {
  decision: RiskDecision;
  record: RiskDecisionRecord;
}

/** Evaluate an event against the DB-backed velocity count and persist the decision. */
export async function evaluateAndRecordRisk(input: EvaluateRiskInput): Promise<EvaluateRiskResult> {
  const thresholds = input.thresholds ?? DEFAULT_RISK_THRESHOLDS;
  const velocityCount = await countRecentRiskDecisions(input.tenantId, input.occurredAt);
  const { verdict, score, reasons } = evaluateRisk(input.amountCents, velocityCount, thresholds);

  const decision: RiskDecision = {
    eventId: input.eventId,
    tenantId: input.tenantId,
    verdict,
    score,
    reasons,
  };

  const record = await prisma.riskDecision.upsert({
    where: { eventId: input.eventId },
    update: { verdict, score, reasons: reasons as unknown as Prisma.InputJsonValue },
    create: {
      eventId: input.eventId,
      tenantId: input.tenantId,
      verdict,
      score,
      reasons: reasons as unknown as Prisma.InputJsonValue,
    },
  });

  return { decision, record };
}
