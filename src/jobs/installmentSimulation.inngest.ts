/**
 * Job: billing/installment.simulation
 *
 * Super-admin simulation of the BNPL installment lifecycle.
 * Uses configurable second-level delays instead of real monthly intervals.
 * Each installment has its own 3-attempt dunning at configurable retry delays.
 */
import { Decimal } from '@prisma/client/runtime/library';
import { inngest }    from '../lib/inngest';
import { prisma }     from '../lib/prisma';
import { decrypt }    from '../lib/encryption';
import { getAdapter } from '../adapters/registry';
import { VpsAdapter } from '../adapters/vps.adapter';
import { maskObject } from '../lib/mask';

interface InstallmentSimPayload {
  agreementId:  string;
  tenantId:     string;
  chargeDelay:  string;  // e.g. "30s" — wait between installments
  retryDelay1:  string;  // e.g. "15s" — dunning retry 1
  retryDelay2:  string;  // e.g. "30s" — dunning retry 2
  retryDelay3:  string;  // e.g. "60s" — dunning retry 3
}

async function simInstallmentCharge(
  agreementId:       string,
  tenantId:          string,
  chargeId:          string,
  idempotencyId:     string,
  installmentNumber: number,
  attemptNumber:     number,
): Promise<{ success: boolean; errorMessage?: string }> {
  const agreement = await prisma.installmentAgreement.findUniqueOrThrow({
    where: { id: agreementId },
  });

  if (['CANCELLED', 'COMPLETED', 'DEFAULTED'].includes(agreement.status)) {
    return { success: false, errorMessage: `Agreement is ${agreement.status}` };
  }

  const config = await prisma.providerConfig.findFirst({
    where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
  });
  if (!config) {
    return { success: false, errorMessage: 'VPS provider config not found' };
  }

  const adapter        = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
  const profileId      = decrypt(agreement.encryptedStoredProfileId);
  const amountCentimes = Math.round(Number(agreement.installmentAmount) * 100);

  const result = await adapter.chargeRenewal(
    profileId,
    amountCentimes,
    agreement.currency,
    chargeId,
    idempotencyId,
  );

  // Upsert InstallmentCharge
  const existing = await prisma.installmentCharge.findFirst({
    where: { agreementId, installmentNumber },
  });

  const chargeData = {
    status:          result.success ? 'CHARGED' : 'DECLINED',
    vpsTransactionId: result.providerTransactionId ?? null,
    attemptNumber,
    processedAt:     new Date(),
    errorMessage:    result.success ? null : ((result.rawResponse['message'] as string) ?? 'Charge declined'),
  };

  if (existing) {
    await prisma.installmentCharge.update({ where: { id: existing.id }, data: chargeData });
  } else {
    await prisma.installmentCharge.create({
      data: {
        agreementId,
        installmentNumber,
        dueDate:  new Date(),
        amount:   agreement.installmentAmount,
        currency: agreement.currency,
        chargeId,
        ...chargeData,
      },
    });
  }

  return {
    success:      result.success,
    errorMessage: result.success ? undefined : ((result.rawResponse['message'] as string) ?? 'Charge declined'),
  };
}

export const installmentSimulation = inngest.createFunction(
  { id: 'installment-simulation', name: 'Installment Simulation (Admin)', retries: 0 },
  { event: 'billing/installment.simulation' },
  async ({ event, step, runId }) => {
    const {
      agreementId,
      tenantId,
      chargeDelay  = '30s',
      retryDelay1  = '15s',
      retryDelay2  = '30s',
      retryDelay3  = '60s',
    } = event.data as InstallmentSimPayload;

    const agreement = await step.run('validate-agreement', () =>
      prisma.installmentAgreement.findUniqueOrThrow({ where: { id: agreementId } }),
    );

    if (['CANCELLED', 'COMPLETED', 'DEFAULTED'].includes(agreement.status)) {
      return { skipped: true, reason: `Agreement is ${agreement.status}` };
    }

    await step.run('store-run-id', () =>
      prisma.installmentAgreement.update({ where: { id: agreementId }, data: { inngestRunId: runId } }),
    );

    // Determine how many installments remain (down payment = #1, already recorded)
    const startFrom     = agreement.paidCount + 1;
    const totalCharges  = agreement.totalInstallments;

    for (let num = startFrom; num <= totalCharges; num++) {
      // Wait before each charge (simulated monthly interval)
      if (num > startFrom) {
        await step.sleep(`sim-wait-before-inst-${num}`, chargeDelay);
      }

      // Check if cancelled between waits
      const pre = await step.run(`sim-check-before-inst-${num}`, () =>
        prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
      );
      if (pre?.status === 'CANCELLED') return { skipped: true, reason: `Cancelled before installment ${num}` };

      const baseChargeId = `sim-inst-${agreementId.slice(-8)}-${num}`;
      const baseIdem     = `sim-${agreementId}-${num}`;

      // Attempt 1
      const a1 = await step.run(`sim-inst-${num}-attempt-1`, () =>
        simInstallmentCharge(agreementId, tenantId, baseChargeId, baseIdem, num, 1),
      );
      if (a1.success) {
        await step.run(`sim-inst-${num}-advance`, () => advanceSimAgreement(agreementId, num));
        continue;
      }

      // Retry 2
      await step.sleep(`sim-inst-${num}-wait-r2`, retryDelay1);
      const pre2 = await step.run(`sim-inst-${num}-check-r2`, () =>
        prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
      );
      if (pre2?.status === 'CANCELLED') return { skipped: true, reason: `Cancelled during dunning on installment ${num}` };

      const a2 = await step.run(`sim-inst-${num}-attempt-2`, () =>
        simInstallmentCharge(agreementId, tenantId, `${baseChargeId}-r2`, `${baseIdem}-r2`, num, 2),
      );
      if (a2.success) {
        await step.run(`sim-inst-${num}-advance-r2`, () => advanceSimAgreement(agreementId, num));
        continue;
      }

      // Retry 3
      await step.sleep(`sim-inst-${num}-wait-r3`, retryDelay2);
      const pre3 = await step.run(`sim-inst-${num}-check-r3`, () =>
        prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
      );
      if (pre3?.status === 'CANCELLED') return { skipped: true, reason: `Cancelled during dunning on installment ${num}` };

      const a3 = await step.run(`sim-inst-${num}-attempt-3`, () =>
        simInstallmentCharge(agreementId, tenantId, `${baseChargeId}-r3`, `${baseIdem}-r3`, num, 3),
      );
      if (a3.success) {
        await step.run(`sim-inst-${num}-advance-r3`, () => advanceSimAgreement(agreementId, num));
        continue;
      }

      // Final retry
      await step.sleep(`sim-inst-${num}-wait-r4`, retryDelay3);
      const pre4 = await step.run(`sim-inst-${num}-check-r4`, () =>
        prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
      );
      if (pre4?.status === 'CANCELLED') return { skipped: true, reason: `Cancelled during dunning on installment ${num}` };

      const a4 = await step.run(`sim-inst-${num}-attempt-4`, () =>
        simInstallmentCharge(agreementId, tenantId, `${baseChargeId}-r4`, `${baseIdem}-r4`, num, 4),
      );
      if (a4.success) {
        await step.run(`sim-inst-${num}-advance-r4`, () => advanceSimAgreement(agreementId, num));
        continue;
      }

      // All retries exhausted for this installment → DEFAULT
      await step.run(`sim-inst-${num}-default`, () =>
        prisma.installmentAgreement.update({
          where: { id: agreementId },
          data:  { status: 'DEFAULTED', inngestRunId: null },
        }),
      );

      return { defaulted: true, agreementId, onInstallment: num };
    }

    // All installments paid
    await step.run('sim-complete', () =>
      prisma.installmentAgreement.update({
        where: { id: agreementId },
        data:  { status: 'COMPLETED', inngestRunId: null, nextChargeDate: null },
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
  const isComplete   = newPaidCount >= agreement.totalInstallments;

  return prisma.installmentAgreement.update({
    where: { id: agreementId },
    data: {
      paidCount:     newPaidCount,
      status:        isComplete ? 'COMPLETED' : 'ACTIVE',
      inngestRunId:  isComplete ? null : agreement.inngestRunId,
      nextChargeDate: isComplete ? null : new Date(),
    },
  });
}
