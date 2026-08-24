import { z } from "zod";

export const napsCredentialsSchema = z.object({
  merchantId: z.string().min(1),
  terminalId: z.string().min(1),
  secretKey: z.string().min(1),
  baseUrl: z.string().url(),
});

export const vpsCredentialsSchema = z.object({
  // Paywall (front-end redirect)
  merchantAccount: z.string().min(1),
  paywallSecretKey: z.string().min(1),
  paywallUrl: z.string().url(),
  skin: z.string().optional(),
  doFundsAuthOnly: z.boolean().optional(),
  /** Must be 'DEEP_LINK' — required by Payzone's /pwthree/api/initialize endpoint */
  mode: z.string().optional(),
  paymentMethod: z.string().optional(),
  showPaymentProfiles: z.string().optional(),
  // Server-to-server API
  apiUrl: z.string().url(),
  callerName: z.string().min(1),
  callerPassword: z.string().min(1),
  // Webhook verification
  notificationKey: z.string().optional(),
  callbackTestMode: z.boolean().optional(),
});

export const stripeCredentialsSchema = z.object({
  secretKey: z.string().min(1),
  webhookSecret: z.string().min(1),
  publishableKey: z.string().optional(),
});

export const providerConfigStatusSchema = z.object({
  enabled: z.boolean(),
});
