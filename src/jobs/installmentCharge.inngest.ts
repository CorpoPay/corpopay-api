/**
 * Job: billing/installment.charge.due
 *
 * Scheduled recurring charge for a single installment in a BNPL agreement.
 * Fired by the webhook processor (for installment #2) and by itself (all
 * subsequent installments) after each successful charge.
 *
 * Dunning: 3 retries at +1d / +2d / +4d, then DEFAULTED.
 */

import { chargeInstallment, runDunningLadder } from "../lib/dunning";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";

interface InstallmentChargePayload {
  agreementId: string;
  installmentNumber: number;
  tenantId: string;
  chargeId: string;
  idempotencyId: string;
}

export const installmentCharge = inngest.createFunction(
  {
    id: "installment-charge",
    name: "Installment Charge",
    retries: 0,
    triggers: [{ event: "billing/installment.charge.due" }],
  },
  async ({ event, step, runId }) => {
    const { agreementId, installmentNumber, tenantId, chargeId, idempotencyId } =
      event.data as InstallmentChargePayload;

    const agreement = await step.run("validate-agreement", async () => {
      return prisma.installmentAgreement.findUniqueOrThrow({ where: { id: agreementId } });
    });

    if (["CANCELLED", "COMPLETED", "DEFAULTED"].includes(agreement.status)) {
      return { skipped: true, reason: `Agreement is ${agreement.status}` };
    }

    await step.run("store-run-id", async () => {
      return prisma.installmentAgreement.update({
        where: { id: agreementId },
        data: { inngestRunId: runId },
      });
    });

    return runDunningLadder({
      step,
      maxAttempts: 4,
      delays: ["1d", "2d", "4d"],
      stepNames: {
        attempt: (n) => `charge-attempt-${n}`,
        wait: (n) => `wait-retry-${n}`,
        check: (n) => `check-before-${n}`,
      },
      attempt: (n) =>
        chargeInstallment({
          agreementId,
          tenantId,
          chargeId: n === 1 ? chargeId : `${chargeId}-r${n}`,
          idempotencyId: n === 1 ? idempotencyId : `${idempotencyId}-r${n}`,
          installmentNumber,
          attemptNumber: n,
        }),
      shouldStop: async (n) => {
        const a = await prisma.installmentAgreement.findUnique({
          where: { id: agreementId },
          select: { status: true },
        });
        if (a?.status === "CANCELLED") {
          return { stop: true, reason: `Cancelled before retry ${n}` };
        }
        return { stop: false, reason: "" };
      },
      onSuccess: (step, n) =>
        step.run(`on-success-${n}`, () => onInstallmentSuccess(agreementId, installmentNumber)),
      onFailure: async () => {
        // Production installment dunning has no per-failure side effects.
      },
      onExhausted: async (step) => {
        await step.run("mark-defaulted", async () => {
          return prisma.installmentAgreement.update({
            where: { id: agreementId },
            data: { status: "DEFAULTED", inngestRunId: null },
          });
        });
        return { defaulted: true, agreementId, installmentNumber };
      },
    });
  },
);

// ── Shared success handler ─────────────────────────────────────────────────────

async function onInstallmentSuccess(agreementId: string, installmentNumber: number) {
  const agreement = await prisma.installmentAgreement.findUniqueOrThrow({
    where: { id: agreementId },
  });

  const newPaidCount = agreement.paidCount + 1;
  const isComplete = newPaidCount >= agreement.totalInstallments;

  if (isComplete) {
    await prisma.installmentAgreement.update({
      where: { id: agreementId },
      data: {
        paidCount: newPaidCount,
        status: "COMPLETED",
        inngestRunId: null,
        nextChargeDate: null,
      },
    });
    return { complete: true, agreementId };
  }

  // Schedule next installment charge (+1 month)
  const nextChargeDate = new Date();
  nextChargeDate.setUTCMonth(nextChargeDate.getUTCMonth() + 1);

  await prisma.installmentAgreement.update({
    where: { id: agreementId },
    data: { paidCount: newPaidCount, nextChargeDate, inngestRunId: null },
  });

  const nextNumber = installmentNumber + 1;
  const nextChargeId = `inst-${agreementId.slice(-8)}-${nextNumber}`;
  const nextIdem = `${agreementId}-inst-${nextNumber}`;

  await inngest.send({
    id: nextIdem,
    name: "billing/installment.charge.due",
    data: {
      agreementId,
      installmentNumber: nextNumber,
      tenantId: agreement.tenantId,
      chargeId: nextChargeId,
      idempotencyId: nextIdem,
    },
    // schedule for the actual next charge date using Inngest's delayed delivery
    // (Inngest cloud: set ts; dev server: fires immediately)
  });

  return { success: true, nextInstallment: nextNumber, nextChargeDate };
}
