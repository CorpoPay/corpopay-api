import { Router } from "express";

import type { MerchantOnboarding } from "@/generated/prisma/client";

import {
  approveOnboarding,
  getOnboarding,
  rejectOnboarding,
  requestInfoOnboarding,
  submitOnboarding,
  upsertOnboarding,
} from "../lib/onboarding-db";
import type { PolicySpec } from "../lib/settlement-policy";
import { requireAdmin, requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import {
  rejectOnboardingSchema,
  requestInfoOnboardingSchema,
  upsertOnboardingSchema,
} from "../schemas/onboarding";

function toResponse(onboarding: MerchantOnboarding) {
  return {
    id: onboarding.id,
    tenantId: onboarding.tenantId,
    status: onboarding.status,
    legalName: onboarding.legalName,
    entityType: onboarding.entityType,
    registrationNumber: onboarding.registrationNumber,
    country: onboarding.country,
    businessAddress: onboarding.businessAddress,
    website: onboarding.website,
    contactEmail: onboarding.contactEmail,
    industry: onboarding.industry,
    mcc: onboarding.mcc,
    riskTier: onboarding.riskTier,
    submittedAt: onboarding.submittedAt,
    reviewerId: onboarding.reviewerId,
    reviewNotes: onboarding.reviewNotes,
    rejectionReason: onboarding.rejectionReason,
    approvedAt: onboarding.approvedAt,
    createdAt: onboarding.createdAt,
    updatedAt: onboarding.updatedAt,
  };
}

// ─── Merchant (owner) routes — draft + submit ────────────────────────────────────

const router = Router();

// GET /onboarding — the tenant's own onboarding application (404 before drafting).
router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const onboarding = await getOnboarding(req.user!.tenantId);
    if (!onboarding) {
      throw new AppError(404, "ONBOARDING_NOT_FOUND", "Onboarding not found");
    }
    res.json(toResponse(onboarding));
  }),
);

// PUT /onboarding — create or update the draft (idempotent).
router.put(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = upsertOnboardingSchema.parse(req.body);
    const onboarding = await upsertOnboarding(req.user!.tenantId, input);
    res.json(toResponse(onboarding));
  }),
);

// POST /onboarding/submit — submit a complete application for review.
router.post(
  "/submit",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const onboarding = await submitOnboarding(req.user!.tenantId);
    res.json(toResponse(onboarding));
  }),
);

export default router;

// ─── CorpoPay reviewer (admin) routes — approve / reject / request info ─────────

export const adminOnboardingRouter = Router();

// POST /admin/onboarding/:tenantId/approve — approve and resolve the industry preset.
adminOnboardingRouter.post(
  "/:tenantId/approve",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { onboarding, policySpec } = await approveOnboarding(req.params.tenantId, req.user!.id);
    res.json({ ...toResponse(onboarding), policySpec: toPolicySpecResponse(policySpec) });
  }),
);

// POST /admin/onboarding/:tenantId/reject — reject with a reason.
adminOnboardingRouter.post(
  "/:tenantId/reject",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { reason } = rejectOnboardingSchema.parse(req.body);
    const onboarding = await rejectOnboarding(req.params.tenantId, req.user!.id, reason);
    res.json(toResponse(onboarding));
  }),
);

// POST /admin/onboarding/:tenantId/request-info — ask the merchant for more data.
adminOnboardingRouter.post(
  "/:tenantId/request-info",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { notes } = requestInfoOnboardingSchema.parse(req.body);
    const onboarding = await requestInfoOnboarding(req.params.tenantId, req.user!.id, notes);
    res.json(toResponse(onboarding));
  }),
);

/** Serialize a resolved policy spec back to camelCase (centime-exact fields). */
function toPolicySpecResponse(spec: PolicySpec) {
  return {
    industry: spec.industry,
    mcc: spec.mcc,
    availabilityMode: spec.availabilityMode,
    availabilityDelayDays: spec.availabilityDelayDays,
    reserveType: spec.reserveType,
    reservePercentageBps: spec.reservePercentageBps,
    reserveHoldDays: spec.reserveHoldDays,
    reserveFixedCents: spec.reserveFixedCents,
    payoutSchedule: spec.payoutSchedule,
    payoutMinCents: spec.payoutMinCents,
    reversalFunding: spec.reversalFunding,
    allowNegative: spec.allowNegative,
    splittingEnabled: spec.splittingEnabled,
  };
}
