import { z } from "zod";
import {
  AvailabilityMode,
  PayoutSchedule,
  ReserveType,
  ReversalFundingPolicy,
} from "@/generated/prisma/client";

export const createSettlementPolicySchema = z.object({
  name: z.string().min(1).max(100).nullish(),
  industry: z.string().min(1).max(50).nullish(),
  mcc: z.string().min(1).max(8).nullish(),
  availabilityMode: z.nativeEnum(AvailabilityMode).nullish(),
  availabilityDelayDays: z.number().int().nonnegative().nullish(),
  reserveType: z.nativeEnum(ReserveType).nullish(),
  reservePercentageBps: z.number().int().nonnegative().nullish(),
  reserveHoldDays: z.number().int().nonnegative().nullish(),
  reserveFixedCents: z.number().int().nonnegative().nullish(),
  payoutSchedule: z.nativeEnum(PayoutSchedule).nullish(),
  payoutMinCents: z.number().int().nonnegative().nullish(),
  reversalFunding: z.nativeEnum(ReversalFundingPolicy).nullish(),
  allowNegative: z.boolean().nullish(),
  splittingEnabled: z.boolean().nullish(),
  feeScheduleId: z.string().nullish(),
});
