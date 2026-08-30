import { z } from "zod";

export const createSettlementStatementSchema = z
  .object({
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    currency: z.string().min(1).max(10).nullish(),
  })
  .refine((input) => input.periodStart.getTime() < input.periodEnd.getTime(), {
    message: "periodStart must be before periodEnd",
    path: ["periodEnd"],
  });
