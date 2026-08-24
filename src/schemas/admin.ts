import { z } from "zod";

export const providerHealthSchema = z.object({
  status: z.enum(["NORMAL", "DEGRADED", "DOWN"]),
  notes: z.string().max(500).optional(),
});

export const tenantStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]),
});
