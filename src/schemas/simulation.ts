import { z } from "zod";

export const startSchema = z.object({
  tenantId: z.string().min(1),
  amount: z.number().positive().default(1.0), // MAD
  currency: z.string().default("MAD"),
  /** Seconds between dunning retry 1→2 */
  retryDelay1: z.number().int().min(5).max(3600).default(30),
  /** Seconds between dunning retry 2→3 */
  retryDelay2: z.number().int().min(5).max(3600).default(60),
  /** Seconds between dunning retry 3→4 (final) */
  retryDelay3: z.number().int().min(5).max(3600).default(120),
});

export const bnplPrepareSchema = z.object({
  tenantId: z.string().min(1),
  amount: z.number().positive().default(1000),
  months: z.number().int().min(1).max(120).default(3),
  apr: z.number().min(0).max(100).default(0),
});

export const prepareSchema = z.object({
  tenantId: z.string().min(1),
  amount: z.number().positive().default(1.0),
});

export const bnplFireSchema = z.object({
  agreementId: z.string().min(1),
  chargeDelay: z.number().int().min(5).max(3600).default(30),
  retryDelay1: z.number().int().min(5).max(3600).default(15),
  retryDelay2: z.number().int().min(5).max(3600).default(30),
  retryDelay3: z.number().int().min(5).max(3600).default(60),
});
