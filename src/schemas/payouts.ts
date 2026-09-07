import { z } from "zod";
import { PayoutMethod, Provider } from "@/generated/prisma/client";

export const createPayoutSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  provider: z.nativeEnum(Provider),
  method: z.nativeEnum(PayoutMethod).nullish(),
});

/**
 * Body for `POST /payouts/:id/process`. For the `MANUAL` rail the operator pays
 * out-of-band and confirms with an optional transfer reference (their bank
 * transfer id). For `STRIPE_CONNECT` the body is ignored — the provider returns
 * the transfer id.
 */
export const processPayoutSchema = z
  .object({
    providerTransferId: z.string().max(200).nullish(),
  })
  .default({});
