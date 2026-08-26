import { z } from "zod";
import { PayoutMethod, Provider } from "@/generated/prisma/client";

export const createPayoutSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  provider: z.nativeEnum(Provider),
  method: z.nativeEnum(PayoutMethod).nullish(),
});
