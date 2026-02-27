/**
 * Job: billing/installment.charge.due
 *
 * Scheduled recurring charge for a single installment in a BNPL agreement.
 * Fired by the webhook processor (for installment #2) and by itself (all
 * subsequent installments) after each successful charge.
 *
 * Dunning: 3 retries at +1d / +2d / +4d, then DEFAULTED.
 */
import { Decimal } from '@prisma/client/runtime/library';
import { inngest }    from '../lib/inngest';
import { prisma }     from '../lib/prisma';
import { decrypt }    from '../lib/encryption';
import { getAdapter } from '../adapters/registry';
import { VpsAdapter } from '../adapters/vps.adapter';
import { maskObject } from '../lib/mask';

interface InstallmentChargePayload {
  agreementId:      string;
  installmentNumber: number;
  tenantId:         string;
  chargeId:         string;
  idempotencyId:    string;
}

async function attemptInstallmentCharge(
  agreementId:       string,
  tenantId:          string,
  chargeId:          string,
  idempotencyId:     string,
  installmentNumber: number,
  attemptNumber:     number,
): Promise<{ success: boolean; vpsTransactionId?: string; errorMessage?: string }> {
  const agreement = await prisma.installmentAgreement.findUniqueOrThrow({
    where: { id: agreementId },
  });

  if (agreement.status === 'CANCELLED' || agreement.status === 'COMPLETED' || agreement.status === 'DEFAULTED') {
    return { success: false, errorMessage: `Agreement is ${agreement.status}` };
  }

  const config = await prisma.providerConfig.findFirst({
    where: { tenantId, provider: 'VPS', status: 'CONNECTED' },
  });
  if (!config) {
    return { success: false, errorMessage: 'VPS provider config not found or disconnected' };
  }

  const adapter   = getAdapter('VPS', config.encryptedCredentials) as VpsAdapter;
  const profileId = decrypt(agreement.encryptedStoredProfileId);
  const amountCentimes = Math.round(Number(agreement.installmentAmount) * 100);

  const result = await adapter.chargeRenewal(
    profileId,
    amountCentimes,
    agreement.currency,
    chargeId,
    idempotencyId,
  );

  // Upsert the InstallmentCharge record
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
    success:          result.success,
    vpsTransactionId: result.providerTransactionId,
    errorMessage:     result.success ? undefined : ((result.rawResponse['message'] as string) ?? 'Charge declined'),
  };
}

export const installmentCharge = inngest.createFunction(
  {
    id:      'installment-charge',
    name:    'Installment Charge',
    retries: 0,
  },
  { event: 'billing/installment.charge.due' },
  async ({ event, step, runId }) => {
    const { agreementId, installmentNumber, tenantId, chargeId, idempotencyId } =
      event.data as InstallmentChargePayload;

    const agreement = await step.run('validate-agreement', async () => {
      return prisma.installmentAgreement.findUniqueOrThrow({ where: { id: agreementId } });
    });

    if (['CANCELLED', 'COMPLETED', 'DEFAULTED'].includes(agreement.status)) {
      return { skipped: true, reason: `Agreement is ${agreement.status}` };
    }

    await step.run('store-run-id', async () => {
      return prisma.installmentAgreement.update({
        where: { id: agreementId },
        data:  { inngestRunId: runId },
      });
    });

    // ── Attempt 1 ──────────────────────────────────────────────────────────────
    const attempt1 = await step.run('charge-attempt-1', () =>
      attemptInstallmentCharge(agreementId, tenantId, chargeId, idempotencyId, installmentNumber, 1),
    );

    if (attempt1.success) {
      return await step.run('on-success-1', () =>
        onInstallmentSuccess(agreementId, installmentNumber),
      );
    }

    // ── Retry 2 (+1d) ──────────────────────────────────────────────────────────
    await step.sleep('wait-retry-2', '1d');

    const pre2 = await step.run('check-before-2', () =>
      prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
    );
    if (pre2?.status === 'CANCELLED') return { skipped: true, reason: 'Cancelled before retry 2' };

    const attempt2 = await step.run('charge-attempt-2', () =>
      attemptInstallmentCharge(agreementId, tenantId, `${chargeId}-r2`, `${idempotencyId}-r2`, installmentNumber, 2),
    );
    if (attempt2.success) {
      return await step.run('on-success-2', () =>
        onInstallmentSuccess(agreementId, installmentNumber),
      );
    }

    // ── Retry 3 (+2d) ──────────────────────────────────────────────────────────
    await step.sleep('wait-retry-3', '2d');

    const pre3 = await step.run('check-before-3', () =>
      prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
    );
    if (pre3?.status === 'CANCELLED') return { skipped: true, reason: 'Cancelled before retry 3' };

    const attempt3 = await step.run('charge-attempt-3', () =>
      attemptInstallmentCharge(agreementId, tenantId, `${chargeId}-r3`, `${idempotencyId}-r3`, installmentNumber, 3),
    );
    if (attempt3.success) {
      return await step.run('on-success-3', () =>
        onInstallmentSuccess(agreementId, installmentNumber),
      );
    }

    // ── Final retry (+4d) ──────────────────────────────────────────────────────
    await step.sleep('wait-retry-4', '4d');

    const pre4 = await step.run('check-before-4', () =>
      prisma.installmentAgreement.findUnique({ where: { id: agreementId }, select: { status: true } }),
    );
    if (pre4?.status === 'CANCELLED') return { skipped: true, reason: 'Cancelled before retry 4' };

    const attempt4 = await step.run('charge-attempt-4', () =>
      attemptInstallmentCharge(agreementId, tenantId, `${chargeId}-r4`, `${idempotencyId}-r4`, installmentNumber, 4),
    );
    if (attempt4.success) {
      return await step.run('on-success-4', () =>
        onInstallmentSuccess(agreementId, installmentNumber),
      );
    }

    // ── All attempts failed → DEFAULT ─────────────────────────────────────────
    await step.run('mark-defaulted', async () => {
      return prisma.installmentAgreement.update({
        where: { id: agreementId },
        data:  { status: 'DEFAULTED', inngestRunId: null },
      });
    });

    return { defaulted: true, agreementId, installmentNumber };
  },
);

// ── Shared success handler ─────────────────────────────────────────────────────

async function onInstallmentSuccess(agreementId: string, installmentNumber: number) {
  const agreement = await prisma.installmentAgreement.findUniqueOrThrow({
    where: { id: agreementId },
  });

  const newPaidCount = agreement.paidCount + 1;
  const isComplete   = newPaidCount >= agreement.totalInstallments;

  if (isComplete) {
    await prisma.installmentAgreement.update({
      where: { id: agreementId },
      data:  { paidCount: newPaidCount, status: 'COMPLETED', inngestRunId: null, nextChargeDate: null },
    });
    return { complete: true, agreementId };
  }

  // Schedule next installment charge (+1 month)
  const nextChargeDate = new Date();
  nextChargeDate.setUTCMonth(nextChargeDate.getUTCMonth() + 1);

  await prisma.installmentAgreement.update({
    where: { id: agreementId },
    data:  { paidCount: newPaidCount, nextChargeDate, inngestRunId: null },
  });

  const nextNumber   = installmentNumber + 1;
  const nextChargeId = `inst-${agreementId.slice(-8)}-${nextNumber}`;
  const nextIdem     = `${agreementId}-inst-${nextNumber}`;

  await inngest.send({
    id:   nextIdem,
    name: 'billing/installment.charge.due',
    data: {
      agreementId,
      installmentNumber: nextNumber,
      tenantId:          agreement.tenantId,
      chargeId:          nextChargeId,
      idempotencyId:     nextIdem,
    },
    // schedule for the actual next charge date using Inngest's delayed delivery
    // (Inngest cloud: set ts; dev server: fires immediately)
  });

  return { success: true, nextInstallment: nextNumber, nextChargeDate };
}
