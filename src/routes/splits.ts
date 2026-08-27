import { Router } from "express";

import type { Split, SplitParty, SplitRule } from "@/generated/prisma/client";

import { centimes, madToCentimes } from "../lib/money";
import {
  createSplitParty,
  createSplitRule,
  deactivateSplitParty,
  deactivateSplitRule,
  executeSplit,
  getSplit,
  getSplitParty,
  getSplitRule,
  listSplitParties,
  listSplitRules,
  listSplits,
  releaseSplit,
} from "../lib/splits-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import {
  createSplitPartySchema,
  createSplitRuleSchema,
  executeSplitSchema,
} from "../schemas/splits";

function partyToResponse(party: SplitParty) {
  return {
    id: party.id,
    slug: party.slug,
    name: party.name,
    type: party.type,
    isActive: party.isActive,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
  };
}

function ruleToResponse(rule: SplitRule) {
  return {
    id: rule.id,
    name: rule.name,
    trigger: rule.trigger,
    shares: rule.shares,
    isActive: rule.isActive,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function splitToResponse(split: Split) {
  return {
    id: split.id,
    splitRuleId: split.splitRuleId,
    sourceType: split.sourceType,
    sourceId: split.sourceId,
    partyId: split.partyId,
    amountCents: madToCentimes(split.amount),
    currency: split.currency,
    status: split.status,
    heldUntil: split.heldUntil,
    createdAt: split.createdAt,
    updatedAt: split.updatedAt,
  };
}

// ─── Split parties (beneficiaries) ──────────────────────────────────────────────

export const splitPartiesRouter = Router();

splitPartiesRouter.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createSplitPartySchema.parse(req.body);
    const party = await createSplitParty(req.user!.tenantId, {
      slug: input.slug,
      name: input.name,
      type: input.type ?? undefined,
    });
    res.status(201).json(partyToResponse(party));
  }),
);

splitPartiesRouter.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const parties = await listSplitParties(req.user!.tenantId);
    res.json(parties.map(partyToResponse));
  }),
);

splitPartiesRouter.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const party = await getSplitParty(req.user!.tenantId, req.params.id);
    if (!party) throw new AppError(404, "SPLIT_PARTY_NOT_FOUND", "Split party not found");
    res.json(partyToResponse(party));
  }),
);

splitPartiesRouter.post(
  "/:id/deactivate",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const party = await deactivateSplitParty(req.user!.tenantId, req.params.id);
    res.json(partyToResponse(party));
  }),
);

// ─── Split rules (templates) ────────────────────────────────────────────────────

export const splitRulesRouter = Router();

splitRulesRouter.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createSplitRuleSchema.parse(req.body);
    const rule = await createSplitRule(req.user!.tenantId, {
      name: input.name,
      trigger: input.trigger ?? undefined,
      shares: input.shares,
    });
    res.status(201).json(ruleToResponse(rule));
  }),
);

splitRulesRouter.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const rules = await listSplitRules(req.user!.tenantId);
    res.json(rules.map(ruleToResponse));
  }),
);

splitRulesRouter.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const rule = await getSplitRule(req.user!.tenantId, req.params.id);
    if (!rule) throw new AppError(404, "SPLIT_RULE_NOT_FOUND", "Split rule not found");
    res.json(ruleToResponse(rule));
  }),
);

splitRulesRouter.post(
  "/:id/deactivate",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const rule = await deactivateSplitRule(req.user!.tenantId, req.params.id);
    res.json(ruleToResponse(rule));
  }),
);

// ─── Splits (executions) ────────────────────────────────────────────────────────

export const splitsRouter = Router();

splitsRouter.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = executeSplitSchema.parse(req.body);
    const splits = await executeSplit(req.user!.tenantId, {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceCents: centimes(input.sourceCents),
      splitRuleId: input.splitRuleId ?? null,
      trigger: input.trigger ?? undefined,
      shares: input.shares ?? undefined,
      held: input.held ?? false,
      heldUntil: input.heldUntil ?? null,
    });
    res.status(201).json(splits.map(splitToResponse));
  }),
);

splitsRouter.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const { sourceType, sourceId } = req.query as { sourceType?: string; sourceId?: string };
    const filter = sourceType || sourceId ? { sourceType, sourceId } : undefined;
    const splits = await listSplits(req.user!.tenantId, filter);
    res.json(splits.map(splitToResponse));
  }),
);

splitsRouter.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const split = await getSplit(req.user!.tenantId, req.params.id);
    if (!split) throw new AppError(404, "SPLIT_NOT_FOUND", "Split not found");
    res.json(splitToResponse(split));
  }),
);

splitsRouter.post(
  "/:id/release",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const existing = await getSplit(req.user!.tenantId, req.params.id);
    if (!existing) throw new AppError(404, "SPLIT_NOT_FOUND", "Split not found");
    const split = await releaseSplit(req.user!.tenantId, req.params.id);
    res.json(splitToResponse(split));
  }),
);
