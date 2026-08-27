import { z } from "zod";

import { Provider } from "@/generated/prisma/client";

const reconciliationLineSchema = z.object({
  /** External (provider) reference — matched against the ledger `sourceId`. */
  reference: z.string().min(1).max(200),
  /** External amount, in centimes. */
  amountCents: z.number().int().nonnegative(),
});

export const createReconciliationReportSchema = z.object({
  provider: z.nativeEnum(Provider),
  currency: z.string().min(1).max(10).nullish(),
  periodStart: z.coerce.date().nullish(),
  periodEnd: z.coerce.date().nullish(),
  lines: z.array(reconciliationLineSchema).min(1),
});
