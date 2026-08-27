import { Router } from "express";

import type { ReconciliationLine } from "@/generated/prisma/client";

import { centimes, madToCentimes } from "../lib/money";
import {
  createReconciliationReport,
  getReconciliationReport,
  listReconciliationReports,
  type ReconciliationReportWithLines,
  resolveReconciliation,
  runReconciliation,
} from "../lib/reconciliation-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import { createReconciliationReportSchema } from "../schemas/reconciliation";

const router = Router();

function lineToResponse(line: ReconciliationLine) {
  return {
    id: line.id,
    reference: line.reference,
    amountCents: madToCentimes(line.amount),
    currency: line.currency,
    status: line.status,
    matchedAmountCents: line.matchedAmount != null ? madToCentimes(line.matchedAmount) : null,
    differenceAmountCents:
      line.differenceAmount != null ? madToCentimes(line.differenceAmount) : null,
    createdAt: line.createdAt,
  };
}

function toResponse(report: ReconciliationReportWithLines) {
  return {
    id: report.id,
    provider: report.provider,
    currency: report.currency,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    status: report.status,
    summary: report.summary,
    lines: report.lines.map(lineToResponse),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

// ─── POST /reconciliation-reports ────────────────────────────────────────────────

// Ingest a provider statement (a list of external lines) for matching.
router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createReconciliationReportSchema.parse(req.body);
    const report = await createReconciliationReport(req.user!.tenantId, {
      provider: input.provider,
      currency: input.currency ?? undefined,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      lines: input.lines.map((line) => ({
        reference: line.reference,
        amountCents: centimes(line.amountCents),
      })),
    });
    res.status(201).json(toResponse(report));
  }),
);

// ─── GET /reconciliation-reports ─────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const reports = await listReconciliationReports(req.user!.tenantId);
    res.json(reports.map(toResponse));
  }),
);

// ─── GET /reconciliation-reports/:id ─────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const report = await getReconciliationReport(req.user!.tenantId, req.params.id);
    if (!report) {
      throw new AppError(404, "RECONCILIATION_NOT_FOUND", "Reconciliation report not found");
    }
    res.json(toResponse(report));
  }),
);

// ─── POST /reconciliation-reports/:id/run ────────────────────────────────────────

// Run the three-way match (provider report ↔ ledger ↔ payouts) and persist the
// per-line + report-level outcome.
router.post(
  "/:id/run",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const report = await runReconciliation(req.user!.tenantId, req.params.id);
    res.json(toResponse(report));
  }),
);

// ─── POST /reconciliation-reports/:id/resolve ────────────────────────────────────

// Close the report after review (terminal).
router.post(
  "/:id/resolve",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    await resolveReconciliation(req.user!.tenantId, req.params.id);
    const report = await getReconciliationReport(req.user!.tenantId, req.params.id);
    res.json(toResponse(report!));
  }),
);

export default router;
