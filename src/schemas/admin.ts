import { z } from "zod";

export const providerHealthSchema = z.object({
  status: z.enum(["NORMAL", "DEGRADED", "DOWN"]),
  notes: z.string().max(500).optional(),
});

export const tenantStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]),
});

/** Manual-payout execution (Morocco model): the admin confirms a bank transfer. */
export const manualPayoutSchema = z.object({
  externalReference: z.string().min(1).max(200),
});
