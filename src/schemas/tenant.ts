import { z } from "zod";
import { SafeUrl } from "./common";

export const updateTenantSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  notifyWebhookUrl: SafeUrl.nullable().optional(),
  notifyEmail: z.string().email().nullable().optional(),
});
