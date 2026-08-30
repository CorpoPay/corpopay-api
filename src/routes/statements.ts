import { Router } from "express";

import { madToCentimes } from "../lib/money";
import {
  createSettlementStatement,
  finalizeSettlementStatement,
  getSettlementStatement,
  listSettlementStatements,
  type SettlementStatementWithItems,
  voidSettlementStatement,
} from "../lib/statements-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createSettlementStatementSchema } from "../schemas/statements";

const router = Router();

function toResponse(statement: SettlementStatementWithItems) {
  return {
    id: statement.id,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    currency: statement.currency,
    status: statement.status,
    openingBalanceCents: madToCentimes(statement.openingBalance),
    closingBalanceCents: madToCentimes(statement.closingBalance),
    netCents: madToCentimes(statement.netAmount),
    finalizedAt: statement.finalizedAt,
    items: statement.items.map((item) => ({
      id: item.id,
      category: item.category,
      amountCents: madToCentimes(item.amount),
      entryCount: item.entryCount,
    })),
    createdAt: statement.createdAt,
    updatedAt: statement.updatedAt,
  };
}

// ─── POST /settlement-statements ────────────────────────────────────────────────

// Snapshot the tenant's ledger over a period into a statement (data the tenant
// invoices from; CorpoPay never sends the email itself).
router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createSettlementStatementSchema.parse(req.body);
    const statement = await createSettlementStatement(req.user!.tenantId, {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: input.currency ?? undefined,
    });
    res.status(201).json(toResponse(statement));
  }),
);

// ─── GET /settlement-statements ─────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const statements = await listSettlementStatements(req.user!.tenantId);
    res.json(statements.map(toResponse));
  }),
);

// ─── GET /settlement-statements/:id ─────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const statement = await getSettlementStatement(req.user!.tenantId, req.params.id);
    if (!statement) {
      throw new AppError(404, "STATEMENT_NOT_FOUND", "Settlement statement not found");
    }
    res.json(toResponse(statement));
  }),
);

// ─── POST /settlement-statements/:id/finalize ───────────────────────────────────

// Lock the statement — it becomes an immutable accounting artifact.
router.post(
  "/:id/finalize",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    await finalizeSettlementStatement(req.user!.tenantId, req.params.id);
    const statement = await getSettlementStatement(req.user!.tenantId, req.params.id);
    res.json(toResponse(statement!));
  }),
);

// ─── POST /settlement-statements/:id/void ───────────────────────────────────────

// Void a statement generated in error (terminal).
router.post(
  "/:id/void",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    await voidSettlementStatement(req.user!.tenantId, req.params.id);
    const statement = await getSettlementStatement(req.user!.tenantId, req.params.id);
    res.json(toResponse(statement!));
  }),
);

export default router;
