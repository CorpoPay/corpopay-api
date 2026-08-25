/**
 * Installment Agreement management — Merchant routes.
 *
 * GET    /installment-agreements            – list tenant agreements
 * GET    /installment-agreements/:id        – detail with all InstallmentCharge rows
 * POST   /installment-agreements/:id/cancel – cancel an ACTIVE agreement
 */
import { Router } from "express";
import { AuditAction } from "@/generated/prisma/client";
import { inngest } from "../lib/inngest";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";

const router = Router();

// GET /installment-agreements
router.get(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const { page = "1", limit = "20", status, customerId } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const db = forTenant(req.user!.tenantId);
    const where = {
      ...(status ? { status: status as any } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [agreements, total] = await Promise.all([
      db.installmentAgreement.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          plan: { select: { name: true, durationMonths: true, annualInterestRate: true } },
          _count: { select: { installmentCharges: true } },
        },
      }),
      db.installmentAgreement.count({ where }),
    ]);

    res.json({
      data: agreements.map((a) => ({
        id: a.id,
        customerId: a.customerId,
        plan: a.plan,
        status: a.status,
        principalAmount: Number(a.principalAmount),
        downPayment: Number(a.downPayment),
        installmentAmount: Number(a.installmentAmount),
        totalInstallments: a.totalInstallments,
        paidCount: a.paidCount,
        currency: a.currency,
        nextChargeDate: a.nextChargeDate,
        chargeCount: a._count.installmentCharges,
        createdAt: a.createdAt,
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  }),
);

// GET /installment-agreements/:id
router.get(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const agreement = await db.installmentAgreement.findFirst({
      where: { id: req.params.id },
      include: {
        plan: { select: { name: true, durationMonths: true, annualInterestRate: true } },
        installmentCharges: { orderBy: { installmentNumber: "asc" } },
      },
    });
    if (!agreement)
      throw new AppError(404, "AGREEMENT_NOT_FOUND", "Installment agreement not found");

    // Never expose the encrypted profile ID
    const { encryptedStoredProfileId: _redacted, inngestRunId: _runId, ...safe } = agreement;
    res.json({
      ...safe,
      principalAmount: Number(safe.principalAmount),
      downPayment: Number(safe.downPayment),
      installmentAmount: Number(safe.installmentAmount),
    });
  }),
);

// POST /installment-agreements/:id/cancel
router.post(
  "/:id/cancel",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const agreement = await db.installmentAgreement.findFirst({
      where: { id: req.params.id },
    });
    if (!agreement)
      throw new AppError(404, "AGREEMENT_NOT_FOUND", "Installment agreement not found");
    if (!["ACTIVE", "PENDING_CHECKOUT"].includes(agreement.status)) {
      throw new AppError(
        400,
        "INVALID_STATE",
        `Cannot cancel agreement in ${agreement.status} state`,
      );
    }

    // Signal any sleeping Inngest run to stop
    if (agreement.inngestRunId) {
      try {
        await inngest.send({
          name: "billing/installment.cancel-requested",
          data: { agreementId: agreement.id, runId: agreement.inngestRunId },
        });
      } catch {
        // Non-fatal
      }
    }

    const updated = await prisma.installmentAgreement.update({
      where: { id: agreement.id },
      data: { status: "CANCELLED", inngestRunId: null },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.INSTALLMENT_AGREEMENT_CANCELLED,
        entityType: "InstallmentAgreement",
        entityId: agreement.id,
        ip: req.ip,
      },
    });

    res.json({ id: updated.id, status: updated.status });
  }),
);

export default router;
