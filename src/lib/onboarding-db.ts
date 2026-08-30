/**
 * Onboarding persistence + lifecycle.
 *
 * A tenant has exactly one `MerchantOnboarding` (`@@unique([tenantId])`). The
 * owner drafts and submits it; a CorpoPay reviewer (admin) approves, rejects, or
 * requests more information. Rejected / info-needed applications can be
 * corrected and resubmitted. On approval the tenant's `industry` resolves to a
 * `SettlementPolicy` spec (the "industry → policy preset" signal) that the
 * finance engine defaults to.
 *
 * No money crosses this boundary — the money invariant is enforced in the
 * ledger/payout/statement modules.
 */
import type { MerchantOnboarding, RiskTier } from "@/generated/prisma/client";

import {
  assertTransition,
  OnboardingError,
  type OnboardingFields,
  policySpecForIndustry,
  suggestedRiskTier,
  validateOnboarding,
} from "./onboarding";
import { prisma } from "./prisma";
import type { PolicySpec } from "./settlement-policy";

export async function getOnboarding(tenantId: string): Promise<MerchantOnboarding | null> {
  return prisma.merchantOnboarding.findFirst({ where: { tenantId } });
}

/** Create (or update) the tenant's draft onboarding. Safe to call repeatedly. */
export async function upsertOnboarding(
  tenantId: string,
  input: OnboardingFields,
): Promise<MerchantOnboarding> {
  const riskTier: RiskTier = input.riskTier ?? suggestedRiskTier(input.industry);
  const data = {
    legalName: input.legalName ?? null,
    entityType: input.entityType ?? null,
    registrationNumber: input.registrationNumber ?? null,
    country: input.country ?? null,
    businessAddress: input.businessAddress ?? null,
    website: input.website ?? null,
    contactEmail: input.contactEmail ?? null,
    industry: input.industry ?? null,
    mcc: input.mcc ?? null,
    riskTier,
  };

  return prisma.merchantOnboarding.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });
}

/** Submit a draft (or correct + resubmit a rejected / info-needed application). */
export async function submitOnboarding(tenantId: string): Promise<MerchantOnboarding> {
  const onboarding = await getOnboarding(tenantId);
  if (!onboarding) {
    throw new OnboardingError(
      "onboarding not found — create it first",
      404,
      "ONBOARDING_NOT_FOUND",
    );
  }
  assertTransition(onboarding.status, "SUBMITTED");
  validateOnboarding(onboarding);

  return prisma.merchantOnboarding.update({
    where: { tenantId },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
}

/** Approve a submitted application and resolve its industry → policy preset. */
export async function approveOnboarding(
  tenantId: string,
  reviewerId: string,
): Promise<{ onboarding: MerchantOnboarding; policySpec: PolicySpec }> {
  const onboarding = await getOnboarding(tenantId);
  if (!onboarding) {
    throw new OnboardingError("onboarding not found", 404, "ONBOARDING_NOT_FOUND");
  }
  assertTransition(onboarding.status, "APPROVED");

  const approved = await prisma.merchantOnboarding.update({
    where: { tenantId },
    data: { status: "APPROVED", approvedAt: new Date(), reviewerId },
  });

  return {
    onboarding: approved,
    policySpec: policySpecForIndustry(onboarding.industry, onboarding.mcc),
  };
}

/** Reject a submitted application with a reason (the merchant may resubmit). */
export async function rejectOnboarding(
  tenantId: string,
  reviewerId: string,
  reason: string,
): Promise<MerchantOnboarding> {
  const onboarding = await getOnboarding(tenantId);
  if (!onboarding) {
    throw new OnboardingError("onboarding not found", 404, "ONBOARDING_NOT_FOUND");
  }
  assertTransition(onboarding.status, "REJECTED");

  return prisma.merchantOnboarding.update({
    where: { tenantId },
    data: { status: "REJECTED", reviewerId, rejectionReason: reason },
  });
}

/** Request more information from the merchant (they may resubmit). */
export async function requestInfoOnboarding(
  tenantId: string,
  reviewerId: string,
  notes: string,
): Promise<MerchantOnboarding> {
  const onboarding = await getOnboarding(tenantId);
  if (!onboarding) {
    throw new OnboardingError("onboarding not found", 404, "ONBOARDING_NOT_FOUND");
  }
  assertTransition(onboarding.status, "NEEDS_INFO");

  return prisma.merchantOnboarding.update({
    where: { tenantId },
    data: { status: "NEEDS_INFO", reviewerId, reviewNotes: notes },
  });
}
