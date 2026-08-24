import { z } from "zod";
import { Provider } from "@/generated/prisma/client";
import { SafeUrl } from "./common";

export const createIntentSchema = z.object({
  provider: z.nativeEnum(Provider),
  amount: z.number().int().positive(), // in centimes
  currency: z.string().default("MAD"),
  reference: z.string().min(1).max(100), // M-1: cap length
  description: z.string().min(1).max(500), // M-1: cap length
  returnUrl: SafeUrl, // H-6: SSRF guard
  successUrl: SafeUrl.optional(),
  cancelUrl: SafeUrl.optional(),
  failureUrl: SafeUrl.optional(),
  webhookUrl: SafeUrl.optional(), // overrides default callback URL
  customerEmail: z.string().email().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerCountry: z.string().optional(),
  customerLocale: z.string().optional(),
  isPreauth: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
  walletMode: z.enum(["apple_pay", "google_pay"]).optional(),
});

export const paySchema = z.object({
  customerIp: z.string().optional(),
  customerEmail: z.string().email().optional().or(z.literal("")),
  customerName: z.string().optional(),
  // BNPL
  installmentPlanId: z.string().optional(),
  downPaymentAmount: z.number().positive().optional(), // MAD, must >= one installment
});
