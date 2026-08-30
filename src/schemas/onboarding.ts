import { z } from "zod";

import { RiskTier } from "@/generated/prisma/client";

/** Upsert (draft) the tenant's onboarding. All fields optional — a draft is partial. */
export const upsertOnboardingSchema = z.object({
  legalName: z.string().min(1).max(200).nullish(),
  entityType: z.string().min(1).max(100).nullish(),
  registrationNumber: z.string().min(1).max(100).nullish(),
  country: z.string().length(2).nullish(), // ISO 3166-1 alpha-2
  businessAddress: z.string().min(1).max(500).nullish(),
  website: z.string().url().nullish(),
  contactEmail: z.string().email().nullish(),
  industry: z.string().min(1).max(50).nullish(),
  mcc: z.string().min(1).max(10).nullish(),
  riskTier: z.nativeEnum(RiskTier).nullish(),
});

export const rejectOnboardingSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const requestInfoOnboardingSchema = z.object({
  notes: z.string().min(1).max(500),
});
