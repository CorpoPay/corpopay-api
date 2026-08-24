/**
 * Job: billing/installment.simulation
 *
 * Super-admin simulation of the BNPL installment lifecycle.
 * Uses configurable second-level delays instead of real monthly intervals.
 * Each installment has its own 3-attempt dunning at configurable retry delays.
 */
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";
import { chargeInstallment, runDunningLadder } from "../lib/dunning";

interface InstallmentSimPayload {
  agreementId: string;
  tenantId: string;
  chargeDelay: string; // e.g. "30s" — wait between installments
  retryDelay1: string; // e.g. "15s" — dunning retry 1
  retryDelay2: string; // e.g. "30s" — dunning retry 2
  retryDelay3: string; // e.g. "60s" — dunning retry 3
}

export const installmentSimulation = inngest.createFunction(
  { id: "installment-simulation", name: "Installment Simulation (Admin)", retries: 0 },
  { event: "billing/installment.simulation" },
  async ({ event, step, runId }) => {
    const {
      agreementId,
      tenantId,
      chargeDelay = "30s",
      retryDelay1 = "15s",
      retryDelay2 = "30s",
      retryDelay3 = "60s",
    } = event.data as InstallmentSimPayload;

    const agreement = await step.run("validate-agreement", () =>
      prisma.installmentAgreement.findUniqueOrThrow({ where: { id: agreementId } }),
    );

    if (["CANCELLED", "COMPLETED", "DEFAULTED"].includes(agreement.status)) {
      return { skipped: true, reason: `Agreement is ${agreement.status}` };
    }

    await step.run("store-run-id", () =>
      prisma.installmentAgreement.update({
        where: { id: agreementId },
        data: { inngestRunId: runId },
      }),
    );

    // Determine how many installments remain (down payment = #1, already recorded)
    const startFrom = agreement.paidCount + 1;
    const totalCharges = agreement.totalInstallments;

    for (let num = startFrom; num <= totalCharges; num++) {
      // Wait before each charge (simulated monthly interval)
      if (num > startFrom) {
        await step.sleep(`sim-wait-before-inst-${num}`, chargeDelay);
      }

      // Check if cancelled between waits
      const pre = await step.run(`sim-check-before-inst-${num}`, () =>
        prisma.installmentAgreement.findUnique({
          where: { id: agreementId },
          select: { status: true },
        }),
      );
      if (pre?.status === "CANCELLED")
        return { skipped: true, reason: `Cancelled before installment ${num}` };

      const baseChargeId = `sim-inst-${agreementId.slice(-8)}-${num}`;
      const baseIdem = `sim-${agreementId}-${num}`;

      const outcome = await runDunningLadder({
        step,
        maxAttempts: 4,
        delays: [retryDelay1, retryDelay2, retryDelay3],
        stepNames: {
          attempt: (n) => `sim-inst-${num}-attempt-${n}`,
          wait: (n) => `sim-inst-${num}-wait-r${n}`,
          check: (n) => `sim-inst-${num}-check-r${n}`,
        },
        attempt: (n) =>
          chargeInstallment({
            agreementId,
            tenantId,
            chargeId: n === 1 ? baseChargeId : `${baseChargeId}-r${n}`,
            idempotencyId: n === 1 ? baseIdem : `${baseIdem}-r${n}`,
            installmentNumber: num,
            attemptNumber: n,
          }),
        shouldStop: async () => {
          const a = await prisma.installmentAgreement.findUnique({
            where: { id: agreementId },
            select: { status: true },
          });
          if (a?.status === "CANCELLED") {
            return { stop: true, reason: `Cancelled during dunning on installment ${num}` };
          }
          return { stop: false, reason: "" };
        },
        onSuccess: (step, n) =>
          step.run(n === 1 ? `sim-inst-${num}-advance` : `sim-inst-${num}-advance-r${n}`, () =>
            advanceSimAgreement(agreementId, num),
          ),
        onFailure: async () => {
          // No per-failure side effects in installment simulation.
        },
        onExhausted: async (step) => {
          await step.run(`sim-inst-${num}-default`, () =>
            prisma.installmentAgreement.update({
              where: { id: agreementId },
              data: { status: "DEFAULTED", inngestRunId: null },
            }),
          );
          return { defaulted: true, agreementId, onInstallment: num };
        },
      });

      if ("skipped" in outcome) return outcome;
      if ("defaulted" in outcome) return outcome;
      // success → continue to next installment
    }

    // All installments paid
    await step.run("sim-complete", () =>
      prisma.installmentAgreement.update({
        where: { id: agreementId },
        data: { status: "COMPLETED", inngestRunId: null, nextChargeDate: null },
      }),
    );

    return { complete: true, agreementId };
  },
);

async function advanceSimAgreement(agreementId: string, installmentNumber: number) {
  const agreement = await prisma.installmentAgreement.findUniqueOrThrow({
    where: { id: agreementId },
  });
  const newPaidCount = Math.max(agreement.paidCount, installmentNumber);
  const isComplete = newPaidCount >= agreement.totalInstallments;

  return prisma.installmentAgreement.update({
    where: { id: agreementId },
    data: {
      paidCount: newPaidCount,
      status: isComplete ? "COMPLETED" : "ACTIVE",
      inngestRunId: isComplete ? null : agreement.inngestRunId,
      nextChargeDate: isComplete ? null : new Date(),
    },
  });
}
