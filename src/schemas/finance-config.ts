import { z } from "zod";

import { FINANCE_CAPABILITIES, WALLET_COMMISSION_BASIS } from "../lib/finance-config";

export const updateFinanceConfigSchema = z.object({
  capabilities: z.array(z.enum(FINANCE_CAPABILITIES)),
  preset: z.string().min(1).max(50).nullish(),
  walletCommissionBasis: z.enum(WALLET_COMMISSION_BASIS).nullish(),
});
