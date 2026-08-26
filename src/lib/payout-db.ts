/**
 * Payout persistence + the settlement ledger posting.
 *
 * A payout moves a tenant's `AVAILABLE` ledger balance to `PAID_OUT`. `createPayout`
 * (idempotent by `idempotencyKey`) snapshots the currently-eligible AVAILABLE
 * credit entries into `PayoutItem` rows — the reconciliation unit that guarantees
 * each ledger entry is settled exactly once (`PayoutItem.ledgerEntryId` is unique).
 * `markPayoutPaid` posts the balanced ledger movement (debit AVAILABLE, credit
 * PAID_OUT) and flips the payout to `PAID`.
 *
 * Amounts cross this module's boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { Payout, PayoutItem, PayoutMethod, Provider } from "@/generated/prisma/client";

import { credit, debit, posting } from "./ledger";
import { postEntry } from "./ledger-db";
import { type Centimes, centimes, centimesToMad, madToCentimes } from "./money";
import { assertTransition, PayoutError } from "./payout";
import { prisma } from "./prisma";

const TERMINAL = new Set(["PAID", "FAILED", "CANCELLED"]);

export type PayoutWithItems = Payout & { items: PayoutItem[] };

export interface CreatePayoutInput {
  idempotencyKey: string;
  provider: Provider;
  method?: PayoutMethod | null;
}

/**
 * Snapshot the tenant's eligible AVAILABLE balance into a DRAFT payout.
 * Idempotent: a repeat call with the same `idempotencyKey` returns the existing
 * payout instead of double-reserving funds.
 */
export async function createPayout(
  tenantId: string,
  input: CreatePayoutInput,
): Promise<PayoutWithItems> {
  const existing = await prisma.payout.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
    include: { items: true },
  });
  if (existing) return existing;

  const eligible = await prisma.ledgerEntry.findMany({
    where: {
      tenantId,
      account: "AVAILABLE",
      direction: "CREDIT",
      payoutItem: { is: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const amountCents = eligible.reduce((sum, entry) => sum + madToCentimes(entry.amount), 0);
  if (amountCents <= 0) throw new PayoutError("no eligible funds to pay out");

  return prisma.$transaction(async (tx) => {
    return tx.payout.create({
      data: {
        tenantId,
        amount: centimesToMad(centimes(amountCents)),
        currency: "MAD",
        status: "DRAFT",
        provider: input.provider,
        method: input.method ?? "BANK_TRANSFER",
        idempotencyKey: input.idempotencyKey,
        items: {
          create: eligible.map((entry) => ({
            ledgerEntryId: entry.id,
            amount: entry.amount,
          })),
        },
      },
      include: { items: true },
    });
  });
}

export async function listPayouts(tenantId: string): Promise<PayoutWithItems[]> {
  return prisma.payout.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
}

export async function getPayout(tenantId: string, id: string): Promise<PayoutWithItems | null> {
  return prisma.payout.findFirst({ where: { id, tenantId }, include: { items: true } });
}

export async function cancelPayout(tenantId: string, id: string): Promise<Payout> {
  const payout = await prisma.payout.findFirst({ where: { id, tenantId } });
  if (!payout) throw new PayoutError("payout not found");
  assertTransition(payout.status, "CANCELLED");
  return prisma.payout.update({ where: { id }, data: { status: "CANCELLED" } });
}

export async function markPayoutFailed(tenantId: string, id: string): Promise<Payout> {
  const payout = await prisma.payout.findFirst({ where: { id, tenantId } });
  if (!payout) throw new PayoutError("payout not found");
  if (TERMINAL.has(payout.status)) {
    throw new PayoutError(`payout is already ${payout.status}`);
  }
  return prisma.payout.update({ where: { id }, data: { status: "FAILED" } });
}

/**
 * Post the settlement movement (AVAILABLE → PAID_OUT) and mark the payout PAID
 * in a single transaction, so money can never move without the status flipping
 * (and vice versa). The provider transfer must already have succeeded (its
 * `providerTransferId` is recorded here for reconciliation).
 */
export async function markPayoutPaid(
  tenantId: string,
  id: string,
  providerTransferId?: string,
): Promise<Payout> {
  return prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findFirst({ where: { id, tenantId } });
    if (!payout) throw new PayoutError("payout not found");
    if (TERMINAL.has(payout.status)) {
      throw new PayoutError(`payout is already ${payout.status}`);
    }

    const amountCents: Centimes = madToCentimes(payout.amount);
    await postEntry(
      tenantId,
      posting(
        debit("AVAILABLE", amountCents, "PAYOUT"),
        credit("PAID_OUT", amountCents, "PAYOUT"),
        { sourceType: "payout", sourceId: id },
      ),
      tx,
    );

    return tx.payout.update({
      where: { id },
      data: { status: "PAID", providerTransferId: providerTransferId ?? null },
    });
  });
}
