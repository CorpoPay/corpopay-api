import { z } from "zod";
import { BillingInterval } from "@/generated/prisma/client";

export const createPaymentLinkSchema = z
  .object({
    amount: z.number().positive().max(1_000_000_00), // centimes, max 1M MAD
    currency: z.string().default("MAD"),
    description: z.string().min(1).max(500),
    reference: z.string().min(1).max(100),
    provider: z.enum(["NAPS", "VPS", "STRIPE"]),
    customerName: z.string().max(100).optional(),
    customerEmail: z.string().email().optional().or(z.literal("")),
    customerPhone: z.string().max(20).optional(),
    expiresAt: z.string().datetime().optional(),
    maxAttempts: z.number().int().min(1).max(10).default(1),
    // ── Recurring billing ──────────────────────────────────────────────────────
    isRecurring: z.boolean().default(false),
    billingInterval: z.nativeEnum(BillingInterval).optional(),
    intervalValue: z.number().int().min(1).max(365).default(1),
    maxRetries: z.number().int().min(1).max(10).default(3),
    // ── BNPL / Installments ─────────────────────────────────────────
    isInstallment: z.boolean().default(false),
  })
  .refine((d) => !d.isRecurring || d.billingInterval != null, {
    message: "billingInterval is required when isRecurring is true",
    path: ["billingInterval"],
  })
  .refine((d) => !d.isRecurring || d.provider === "VPS", {
    message: "Recurring billing is only supported with the VPS provider",
    path: ["provider"],
  })
  .refine((d) => !d.isInstallment || ["VPS"].includes(d.provider), {
    message: "Installment billing is only supported with the VPS provider",
    path: ["provider"],
  })
  .refine((d) => !(d.isInstallment && d.isRecurring), {
    message: "A payment link cannot be both installment and recurring",
    path: ["isInstallment"],
  });
