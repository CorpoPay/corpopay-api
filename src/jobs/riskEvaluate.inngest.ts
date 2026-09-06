/**
 * Job: payment/risk-evaluate
 *
 * The TS port of the deprecated Rails `Risk::EvaluateEventJob`: evaluate a single
 * payment success, persist the decision, and return it. v1 risk is detection —
 * it records decisions but never blocks the payment.
 *
 * Self-contained by design: callers send only `intentId` + `tenantId`; this job
 * resolves the captured amount in one place (PaymentLink MAD -> centimes, or
 * direct-intent metadata centimes) — the same derivation the notifications job
 * uses — so the amount logic never drifts across call sites.
 */
import { inngest } from "../lib/inngest";
import { centimes, madToCentimes } from "../lib/money";
import { prisma } from "../lib/prisma";
import { evaluateAndRecordRisk } from "../lib/risk-db";

interface RiskEvaluateEventData {
  intentId: string;
  tenantId: string;
}

export const riskEvaluate = inngest.createFunction(
  {
    id: "risk-evaluate",
    name: "Risk Evaluate",
    retries: 3,
    triggers: [{ event: "payment/risk-evaluate" }],
  },
  async ({ event }) => {
    const { intentId, tenantId } = event.data as RiskEvaluateEventData;

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { paymentLink: { select: { amount: true } } },
    });
    if (!intent) return { skipped: true, reason: "intent-not-found" };

    const meta = (intent.metadata ?? {}) as Record<string, unknown>;
    const rawAmount = intent.paymentLink
      ? madToCentimes(intent.paymentLink.amount)
      : ((meta["amount"] as number | undefined) ?? null);

    if (rawAmount == null) return { skipped: true, reason: "amount-unknown" };

    const result = await evaluateAndRecordRisk({
      eventId: intentId,
      tenantId,
      amountCents: centimes(rawAmount),
      occurredAt: new Date(),
      type: "payment.intent.succeeded",
    });

    return {
      intentId,
      tenantId,
      verdict: result.decision.verdict,
      score: result.decision.score,
      reasons: result.decision.reasons,
      decisionId: result.record.id,
    };
  },
);
