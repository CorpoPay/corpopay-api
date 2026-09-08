import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../lib/money";
import { SafeUrl } from "./common";

const settlementCurrencySchema = z.enum(SUPPORTED_CURRENCIES);

export const updateTenantSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  notifyWebhookUrl: SafeUrl.nullable().optional(),
  notifyEmail: z.string().email().nullable().optional(),
  rotateWebhookSigningSecret: z.boolean().optional(),
  settlementCurrency: settlementCurrencySchema.optional(),
  taxRateBps: z.number().int().min(0).max(10_000).optional(),
  taxExempt: z.boolean().optional(),
});
