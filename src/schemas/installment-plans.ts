import { z } from "zod";

export const planSchema = z.object({
  name: z.string().min(1).max(100),
  durationMonths: z.number().int().min(1).max(120),
  annualInterestRate: z.number().min(0).max(100), // percent, e.g. 12 = 12% APR
  minAmount: z.number().positive().optional(),
  maxAmount: z.number().positive().optional(),
  isActive: z.boolean().default(true),
});
