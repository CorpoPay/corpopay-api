/**
 * Reversal persistence + the clawback ledger posting.
 *
 * A lost `Dispute` claws the gross amount back from a tenant. `resolveDispute`
 * funds that clawback from the tenant's ledger according to their
 * `reversalFunding` policy: it debits AVAILABLE and/or RESERVE against a CASH
 * credit (money leaves the pool), and records any shortfall as a `Recovery`
 * receivable (PENDING — to be collected later). A won dispute simply closes with
 * no money movement.
 *
 * Amounts cross this module's boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { Dispute, DisputeStatus, Provider, Recovery } from "@/generated/prisma/client";

import { credit, debit, posting } from "./ledger";
import { getTenantLedger, postEntry } from "./ledger-db";
import { type Centimes, centimesToMad, madToCentimes } from "./money";
import { getActiveSettlementPolicy } from "./policy-db";
import { prisma } from "./prisma";
import { assertTransition, fundReversal, ReversalError } from "./reversals";
import { DEFAULT_PRESET } from "./settlement-presets";

export type DisputeWithRecovery = Dispute & { recovery: Recovery | null };

export interface CreateDisputeInput {
  providerDisputeId: string;
  provider: Provider;
  amountCents: Centimes;
  feeCents?: Centimes;
  currency?: string;
  reason?: string | null;
  paymentIntentId?: string | null;
  evidenceDueDate?: Date | null;
}

/**
 * Record an inbound chargeback/dispute. Idempotent by `providerDisputeId` — a
 * repeat call with the same id returns the existing dispute.
 */
export async function createDispute(
  tenantId: string,
  input: CreateDisputeInput,
): Promise<DisputeWithRecovery> {
  const existing = await prisma.dispute.findUnique({
    where: { tenantId_providerDisputeId: { tenantId, providerDisputeId: input.providerDisputeId } },
    include: { recovery: true },
  });
  if (existing) return existing;

  return prisma.dispute.create({
    data: {
      tenantId,
      provider: input.provider,
      providerDisputeId: input.providerDisputeId,
      status: "OPEN",
      amount: centimesToMad(input.amountCents),
      feeAmount: centimesToMad(input.feeCents ?? (0 as Centimes)),
      currency: input.currency ?? "MAD",
      reason: input.reason ?? null,
      paymentIntentId: input.paymentIntentId ?? null,
      evidenceDueDate: input.evidenceDueDate ?? null,
    },
    include: { recovery: true },
  });
}

export async function listDisputes(tenantId: string): Promise<DisputeWithRecovery[]> {
  return prisma.dispute.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: { recovery: true },
  });
}

export async function getDispute(
  tenantId: string,
  id: string,
): Promise<DisputeWithRecovery | null> {
  return prisma.dispute.findFirst({ where: { id, tenantId }, include: { recovery: true } });
}

/**
 * Resolve a dispute to WON or LOST. LOST executes the clawback: funds the gross
 * from AVAILABLE/RESERVE per the tenant's `reversalFunding` policy, posts the
 * balanced ledger movement(s), and records any uncovered shortfall as a
 * `Recovery` receivable.
 */
export async function resolveDispute(
  tenantId: string,
  id: string,
  outcome: Extract<DisputeStatus, "WON" | "LOST">,
): Promise<DisputeWithRecovery> {
  if (outcome === "WON") {
    return prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findFirst({ where: { id, tenantId } });
      if (!dispute) throw new ReversalError("dispute not found");
      assertTransition(dispute.status, "WON");
      return tx.dispute.update({
        where: { id },
        data: { status: "WON" },
        include: { recovery: true },
      });
    });
  }

  // LOST — resolve the funding allocation from a consistent read, then execute
  // the clawback postings + status flip + recovery atomically.
  const dispute = await prisma.dispute.findFirst({ where: { id, tenantId } });
  if (!dispute) throw new ReversalError("dispute not found");
  assertTransition(dispute.status, "LOST");

  const grossCents = madToCentimes(dispute.amount);
  const ledger = await getTenantLedger(tenantId);
  const policy = await getActiveSettlementPolicy(tenantId);
  const allocation = fundReversal(
    {
      reversalFunding: policy?.reversalFunding ?? DEFAULT_PRESET.reversalFunding,
      allowNegative: policy?.allowNegative ?? DEFAULT_PRESET.allowNegative,
    },
    grossCents,
    ledger.balances.AVAILABLE,
    ledger.balances.RESERVE,
  );

  return prisma.$transaction(async (tx) => {
    // Re-check inside the transaction so a concurrent resolve can't double-claw.
    const current = await tx.dispute.findFirst({ where: { id, tenantId } });
    if (!current) throw new ReversalError("dispute not found");
    assertTransition(current.status, "LOST");

    if (allocation.fromAvailable > 0) {
      await postEntry(
        tenantId,
        posting(
          debit("AVAILABLE", allocation.fromAvailable, "CHARGEBACK"),
          credit("CASH", allocation.fromAvailable, "CHARGEBACK"),
          { sourceType: "dispute", sourceId: id },
        ),
        tx,
      );
    }
    if (allocation.fromReserve > 0) {
      await postEntry(
        tenantId,
        posting(
          debit("RESERVE", allocation.fromReserve, "CHARGEBACK"),
          credit("CASH", allocation.fromReserve, "CHARGEBACK"),
          { sourceType: "dispute", sourceId: id },
        ),
        tx,
      );
    }

    const disputed = await tx.dispute.update({
      where: { id },
      data: { status: "LOST" },
      include: { recovery: true },
    });

    if (allocation.uncovered > 0) {
      const recovery = await tx.recovery.create({
        data: {
          tenantId,
          disputeId: id,
          status: "PENDING",
          amount: centimesToMad(allocation.uncovered),
          currency: "MAD",
        },
      });
      return { ...disputed, recovery };
    }

    return disputed;
  });
}
