import { z } from "zod";
import { WalletOwnerType } from "@/generated/prisma/client";

export const createWalletSchema = z.object({
  ownerType: z.nativeEnum(WalletOwnerType),
  ownerId: z.string().min(1).max(200),
  currency: z.string().length(3).nullish(),
});

export const topUpWalletSchema = z.object({
  amountCents: z.number().int().positive(),
  paymentIntentId: z.string().min(1).max(200).nullish(),
});

export const debitWalletSchema = z.object({
  amountCents: z.number().int().positive(),
  method: z.string().min(1).max(50).nullish(),
});

export const refundWalletSchema = z.object({
  amountCents: z.number().int().positive(),
});

export const adjustWalletSchema = z.object({
  amountCents: z.number().int(),
});
