import { z } from "zod";

import { SplitPartyType, SplitTrigger } from "@/generated/prisma/client";

const shareSchema = z.object({
  partyId: z.string().min(1),
  shareBps: z.number().int().positive().max(10000),
});

export const createSplitPartySchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  type: z.nativeEnum(SplitPartyType).nullish(),
});

export const createSplitRuleSchema = z.object({
  name: z.string().min(1).max(200),
  trigger: z.nativeEnum(SplitTrigger).nullish(),
  shares: z
    .array(shareSchema)
    .min(1)
    .refine((shares) => shares.reduce((sum, share) => sum + share.shareBps, 0) <= 10000, {
      message: "beneficiary shares must not exceed 10000 basis points",
    }),
});

export const executeSplitSchema = z.object({
  sourceType: z.string().min(1).max(100),
  sourceId: z.string().min(1).max(200),
  /** Source amount to divide, in centimes. */
  sourceCents: z.number().int().nonnegative(),
  splitRuleId: z.string().nullish(),
  trigger: z.nativeEnum(SplitTrigger).nullish(),
  shares: z
    .array(shareSchema)
    .min(1)
    .refine((shares) => shares.reduce((sum, share) => sum + share.shareBps, 0) <= 10000, {
      message: "beneficiary shares must not exceed 10000 basis points",
    })
    .nullish(),
  held: z.boolean().nullish(),
  heldUntil: z.coerce.date().nullish(),
});
