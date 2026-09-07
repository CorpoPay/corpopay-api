import { Router } from "express";

import {
  DEFAULT_FINANCE_PRESET,
  getEffectiveCapabilities,
  getFinanceConfig,
  upsertFinanceConfig,
} from "../lib/finance-config-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { updateFinanceConfigSchema } from "../schemas/finance-config";

const router = Router();

// ─── GET /finance-config ──────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const capabilities = await getEffectiveCapabilities(req.user!.tenantId);
    const row = await getFinanceConfig(req.user!.tenantId);
    res.json({ capabilities, preset: row?.preset ?? DEFAULT_FINANCE_PRESET });
  }),
);

// ─── PUT /finance-config ──────────────────────────────────────────────────────────

router.put(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = updateFinanceConfigSchema.parse(req.body);
    const row = await upsertFinanceConfig(req.user!.tenantId, input.capabilities, input.preset);
    res.json({ capabilities: row.capabilities, preset: row.preset });
  }),
);

export default router;
