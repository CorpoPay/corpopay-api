import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { getAdapter } from '../adapters/registry';
import { maskObject } from '../lib/mask';
import { AuditAction } from '@prisma/client';

const router = Router();

// ─── POST /transactions/:id/refund ────────────────────────────────────────────────

router.post(
  '/:id/refund',
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where:   { id: req.params.id, tenantId: req.user!.tenantId },
      include: { paymentLink: true, refunds: true },
    });

    if (!intent) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    if (intent.status !== 'SUCCEEDED') {
      throw new AppError(400, 'NOT_REFUNDABLE', 'Only succeeded payments can be refunded');
    }
    if (intent.refunds.some((r) => r.status === 'SUCCEEDED')) {
      throw new AppError(409, 'ALREADY_REFUNDED', 'This transaction has already been refunded');
    }
    if (!intent.providerRef) {
      throw new AppError(400, 'NO_PROVIDER_REF', 'Provider reference not available');
    }

    const config = await prisma.providerConfig.findFirst({
      where: { tenantId: req.user!.tenantId, provider: intent.provider },
    });
    if (!config) throw new AppError(400, 'PROVIDER_NOT_CONFIGURED', 'Provider config missing');

    const adapter = getAdapter(intent.provider, config.encryptedCredentials);

    const amountCentimes = Math.round(Number(intent.paymentLink?.amount ?? (intent.metadata as any)?.amount ?? 0) * 100);
    const currency = intent.paymentLink?.currency ?? (intent.metadata as any)?.currency ?? 'MAD';

    if (!amountCentimes) {
      throw new AppError(400, 'MISSING_AMOUNT', 'Cannot determine refund amount');
    }

    // Create a pending refund record first (for idempotency)
    const refund = await prisma.refund.create({
      data: {
        paymentIntentId: intent.id,
        tenantId:        req.user!.tenantId,
        initiatedBy:     req.user!.id,
        amount:          intent.paymentLink?.amount ?? (intent.metadata as any)?.amount ?? 0,
        currency,
        status:          'PENDING',
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId:   req.user!.tenantId,
        userId:     req.user!.id,
        action:     AuditAction.REFUND_INITIATED,
        entityType: 'Refund',
        entityId:   refund.id,
        metadata:   { intentId: intent.id, amount: amountCentimes, currency },
        ip:         req.ip,
      },
    });

    const result = await adapter.refund(intent.providerRef, amountCentimes, currency);

    const finalStatus = result.success ? 'SUCCEEDED' : 'FAILED';

    const [updatedRefund] = await prisma.$transaction([
      prisma.refund.update({
        where: { id: refund.id },
        data:  { status: finalStatus, providerRefundRef: result.providerRefundRef },
      }),
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data:  { status: result.success ? 'REFUNDED' : 'SUCCEEDED' },
      }),
      prisma.auditLog.create({
        data: {
          tenantId:   req.user!.tenantId,
          userId:     req.user!.id,
          action:     result.success ? AuditAction.REFUND_SUCCEEDED : AuditAction.REFUND_FAILED,
          entityType: 'Refund',
          entityId:   refund.id,
          metadata:   maskObject(result) as any,
          ip:         req.ip,
        },
      }),
      prisma.providerTransaction.create({
        data: {
          paymentIntentId: intent.id,
          provider:        intent.provider,
          rawRequest:      maskObject(result.rawRequest) as any,
          rawResponse:     maskObject(result.rawResponse) as any,
        },
      }),
    ]);

    res.json({
      id:               updatedRefund.id,
      status:           updatedRefund.status,
      amount:           updatedRefund.amount,
      currency:         updatedRefund.currency,
      providerRefundRef: updatedRefund.providerRefundRef,
    });
  }),
);

export default router;
