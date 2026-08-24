/**
 * Installment Plan management — Merchant & Public routes.
 *
 * Merchant (auth required):
 *   GET    /installment-plans                – list all plans for tenant
 *   POST   /installment-plans                – create a plan
 *   PATCH  /installment-plans/:id            – update a plan
 *   DELETE /installment-plans/:id            – delete a plan (blocks if active agreements exist)
 *
 * Public (no auth):
 *   GET    /public/installment-plans/:slug   – active plans for the tenant that owns the link,
 *                                              with per-plan installment preview for the link's amount
 */
import { Router } from "express";
import { AuditAction } from "@/generated/prisma/client";
import { prisma } from "../lib/prisma";
import { forTenant } from "../lib/tenant-db";
import { requireAuth, requireMerchant } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import { computeInstallmentAmount, totalInterest } from "../lib/billing";
import { planSchema } from "../schemas/installment-plans";

// ─── Merchant router ─────────────────────────────────────────────────────────

const router = Router();

// GET /installment-plans
router.get(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const plans = await db.installmentPlan.findMany({
      where: {},
      orderBy: { durationMonths: "asc" },
      include: { _count: { select: { agreements: true } } },
    });
    res.json({
      data: plans.map((p) => ({
        id: p.id,
        name: p.name,
        durationMonths: p.durationMonths,
        annualInterestRate: Number(p.annualInterestRate),
        minAmount: p.minAmount ? Number(p.minAmount) : null,
        maxAmount: p.maxAmount ? Number(p.maxAmount) : null,
        isActive: p.isActive,
        agreementCount: p._count.agreements,
        createdAt: p.createdAt,
      })),
    });
  }),
);

// POST /installment-plans
router.post(
  "/",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const body = planSchema.parse(req.body);

    const plan = await prisma.installmentPlan.create({
      data: {
        tenantId: req.user!.tenantId,
        name: body.name,
        durationMonths: body.durationMonths,
        annualInterestRate: body.annualInterestRate,
        minAmount: body.minAmount ?? null,
        maxAmount: body.maxAmount ?? null,
        isActive: body.isActive,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.INSTALLMENT_PLAN_CREATED,
        entityType: "InstallmentPlan",
        entityId: plan.id,
        ip: req.ip,
      },
    });

    res.status(201).json(plan);
  }),
);

// PATCH /installment-plans/:id
router.patch(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const plan = await db.installmentPlan.findFirst({
      where: { id: req.params.id },
    });
    if (!plan) throw new AppError(404, "PLAN_NOT_FOUND", "Installment plan not found");

    const body = planSchema.partial().parse(req.body);
    const updated = await prisma.installmentPlan.update({
      where: { id: plan.id },
      data: body,
    });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.INSTALLMENT_PLAN_UPDATED,
        entityType: "InstallmentPlan",
        entityId: plan.id,
        ip: req.ip,
      },
    });

    res.json(updated);
  }),
);

// DELETE /installment-plans/:id
router.delete(
  "/:id",
  requireAuth,
  requireMerchant,
  asyncHandler(async (req, res) => {
    const db = forTenant(req.user!.tenantId);
    const plan = await db.installmentPlan.findFirst({
      where: { id: req.params.id },
    });
    if (!plan) throw new AppError(404, "PLAN_NOT_FOUND", "Installment plan not found");

    const activeCount = await db.installmentAgreement.count({
      where: {
        planId: plan.id,
        status: { in: ["ACTIVE", "PENDING_CHECKOUT"] },
      },
    });
    if (activeCount > 0) {
      throw new AppError(
        409,
        "PLAN_HAS_ACTIVE_AGREEMENTS",
        `Cannot delete plan: ${activeCount} active agreement(s) are using it`,
      );
    }

    await prisma.installmentPlan.delete({ where: { id: plan.id } });

    await prisma.auditLog.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        action: AuditAction.INSTALLMENT_PLAN_DELETED,
        entityType: "InstallmentPlan",
        entityId: plan.id,
        ip: req.ip,
      },
    });

    res.json({ deleted: true });
  }),
);

export default router;

// ─── Public router ─────────────────────────────────────────────────────────────

export const publicInstallmentPlansRouter = Router();

publicInstallmentPlansRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const link = await prisma.paymentLink.findFirst({
      where: { slug: req.params.slug },
      include: { tenant: { select: { id: true, status: true } } },
    });
    if (!link) throw new AppError(404, "LINK_NOT_FOUND", "Payment link not found");
    if (!link.isInstallment)
      throw new AppError(400, "NOT_INSTALLMENT", "This link does not support installments");
    if (link.tenant.status === "DISABLED")
      throw new AppError(403, "TENANT_DISABLED", "Merchant not accepting payments");

    const principal = Number(link.amount); // MAD

    const plans = await prisma.installmentPlan.findMany({
      where: { tenantId: link.tenant.id, isActive: true },
      orderBy: { durationMonths: "asc" },
    });

    const previews = plans.map((p) => {
      const apr = Number(p.annualInterestRate);
      const n = p.durationMonths;
      const installment = computeInstallmentAmount(principal, apr, n);
      const interest = totalInterest(principal, apr, n);
      const totalAmount = Math.round((principal + interest) * 100) / 100;

      return {
        planId: p.id,
        name: p.name,
        durationMonths: n,
        annualInterestRate: apr,
        installmentAmount: installment,
        totalAmount,
        totalInterest: interest,
        minAmount: p.minAmount ? Number(p.minAmount) : null,
        maxAmount: p.maxAmount ? Number(p.maxAmount) : null,
      };
    });

    res.json({
      currency: link.currency,
      principal,
      plans: previews,
    });
  }),
);
