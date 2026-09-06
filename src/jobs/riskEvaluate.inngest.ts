/**
 * Job: payment/risk-evaluate
 *
 * The TS port of the deprecated Rails `Risk::EvaluateEventJob`: evaluate a single
 * payment event, persist the decision, and return it. v1 risk is detection —
 * it records decisions but never blocks the payment.
 */

import { inngest } from "../lib/inngest";
import { centimes } from "../lib/money";
import { evaluateAndRecordRisk } from "../lib/risk-db";

interface RiskEvaluateEventData {
  eventId: string;
  tenantId: string;
  amountCents: number;
  occurredAt: string;
  type?: string;
}

export const riskEvaluate = inngest.createFunction(
  {
    id: "risk-evaluate",
    name: "Risk Evaluate",
    retries: 3,
    triggers: [{ event: "payment/risk-evaluate" }],
  },
  async ({ event }) => {
    const data = event.data as RiskEvaluateEventData;
    const result = await evaluateAndRecordRisk({
      eventId: data.eventId,
      tenantId: data.tenantId,
      amountCents: centimes(data.amountCents),
      occurredAt: new Date(data.occurredAt),
      type: data.type ?? "payment.intent.succeeded",
    });

    return {
      eventId: data.eventId,
      tenantId: data.tenantId,
      verdict: result.decision.verdict,
      score: result.decision.score,
      reasons: result.decision.reasons,
      decisionId: result.record.id,
    };
  },
);
