import { z } from "zod";
import { FeeType } from "@/generated/prisma/client";

const feeTierSchema = z.object({
  upToCents: z.number().int().nonnegative(),
  percentageBps: z.number().int().nonnegative(),
});

export const createFeeScheduleSchema = z.object({
  name: z.string().min(1).max(100).nullish(),
  feeType: z.nativeEnum(FeeType),
  flatCents: z.number().int().nonnegative().nullish(),
  percentageBps: z.number().int().nonnegative().nullish(),
  perMethodCents: z.record(z.string(), z.number().int().nonnegative()).nullish(),
  tiersCents: z.array(feeTierSchema).nullish(),
  currency: z.string().length(3).nullish(),
});
