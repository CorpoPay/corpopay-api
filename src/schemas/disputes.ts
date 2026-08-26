import { z } from "zod";

import { Provider } from "@/generated/prisma/client";

export const createDisputeSchema = z.object({
  providerDisputeId: z.string().min(1).max(200),
  provider: z.nativeEnum(Provider),
  /** Gross amount clawed back, in centimes. */
  amount: z.number().int().nonnegative(),
  /** Provider dispute fee, in centimes (informational in Phase 4). */
  feeAmount: z.number().int().nonnegative().nullish(),
  currency: z.string().min(1).max(10).nullish(),
  reason: z.string().max(500).nullish(),
  paymentIntentId: z.string().nullish(),
  evidenceDueDate: z.coerce.date().nullish(),
});

export const resolveDisputeSchema = z.object({
  outcome: z.enum(["WON", "LOST"]),
});
