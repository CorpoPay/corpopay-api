/**
 * Payout persistence + the settlement ledger posting.
 *
 * A payout moves a tenant's `AVAILABLE` ledger balance to `PAID_OUT`. `createPayout`
 * (idempotent by `idempotencyKey`) snapshots the tenant's **net** eligible balance —
 * unpaid AVAILABLE credits minus non-payout AVAILABLE debits (chargeback clawbacks,
 * wallet fees, refunds) — so a payout can never exceed what's actually owed. It
 * writes `PayoutItem` rows (FIFO over the credits, the last possibly partial) that
 * guarantee each ledger credit is settled at most once (`PayoutItem.ledgerEntryId`
 * is unique). `markPayoutPaid` posts the balanced movement (debit AVAILABLE, credit
 * PAID_OUT) and flips the payout to `PAID`.
 *
 * Amounts cross this module's boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type { Payout, PayoutItem, PayoutMethod, Provider } from "@/generated/prisma/client";

import { credit, debit, posting } from "./ledger";
import { accountBalanceCents, postEntry } from "./ledger-db";
import { type Centimes, type Currency, centimes, fromMinor, toMinor } from "./money";
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
 * Snapshot the tenant's net eligible AVAILABLE balance into a DRAFT payout.
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

  return prisma.$transaction(async (tx) => {
    // Serialize money movement for this tenant (the same lock `postEntry` uses)
    // so a concurrent capture/clawback can't skew the snapshot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    // Payouts settle in the tenant's configured settlement currency.
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { settlementCurrency: true },
    });
    const currency: Currency = (tenant?.settlementCurrency as Currency | undefined) ?? "MAD";

    // Unpaid AVAILABLE credits (not yet reserved by any payout), oldest first.
    const credits = await tx.ledgerEntry.findMany({
      where: {
        tenantId,
        account: "AVAILABLE",
        direction: "CREDIT",
        currency,
        payoutItem: { is: null },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    // Non-payout AVAILABLE debits (chargeback clawback, wallet fee, refund, …)
    // reduce what's actually owed. Payout debits are excluded — they already
    // settled a prior payout and don't reduce future eligibility.
    const debitRows = await tx.ledgerEntry.findMany({
      where: {
        tenantId,
        account: "AVAILABLE",
        direction: "DEBIT",
        currency,
        category: { not: "PAYOUT" },
      },
      select: { amount: true },
    });

    const unpaidCredits = credits.reduce((sum, entry) => sum + toMinor(entry.amount, currency), 0);
    const otherDebits = debitRows.reduce((sum, entry) => sum + toMinor(entry.amount, currency), 0);
    const payable = unpaidCredits - otherDebits;
    if (payable <= 0) throw new PayoutError("no eligible funds to pay out");

    // Allocate the net payable FIFO over the oldest credits; the last credit may
    // be partial (its remainder was consumed by a clawback/fee).
    let remaining = payable;
    const items: { ledgerEntryId: string; amount: number }[] = [];
    for (const entry of credits) {
      if (remaining <= 0) break;
      const creditCents = toMinor(entry.amount, currency);
      const alloc = Math.min(creditCents, remaining);
      items.push({ ledgerEntryId: entry.id, amount: fromMinor(centimes(alloc), currency) });
      remaining -= alloc;
    }

    return tx.payout.create({
      data: {
        tenantId,
        amount: fromMinor(centimes(payable), currency),
        currency,
        status: "DRAFT",
        provider: input.provider,
        method: input.method ?? "BANK_TRANSFER",
        idempotencyKey: input.idempotencyKey,
        items: { create: items },
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
  return prisma.$transaction(async (tx) => {
    // Release the reserved credits so a future payout can re-reserve them.
    await tx.payoutItem.deleteMany({ where: { payoutId: id } });
    return tx.payout.update({ where: { id }, data: { status: "CANCELLED" } });
  });
}

export async function markPayoutFailed(tenantId: string, id: string): Promise<Payout> {
  const payout = await prisma.payout.findFirst({ where: { id, tenantId } });
  if (!payout) throw new PayoutError("payout not found");
  if (TERMINAL.has(payout.status)) {
    throw new PayoutError(`payout is already ${payout.status}`);
  }
  return prisma.$transaction(async (tx) => {
    // Release the reserved credits so a future payout can re-reserve them.
    await tx.payoutItem.deleteMany({ where: { payoutId: id } });
    return tx.payout.update({ where: { id }, data: { status: "FAILED" } });
  });
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
    // Serialize money movement for this tenant (the same lock postEntry uses) so
    // a concurrent capture/clawback can't slip in between the re-validation read
    // and the settlement post.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;

    const payout = await tx.payout.findFirst({ where: { id, tenantId } });
    if (!payout) throw new PayoutError("payout not found");
    if (TERMINAL.has(payout.status)) {
      throw new PayoutError(`payout is already ${payout.status}`);
    }

    const payoutCurrency: Currency = payout.currency as Currency;
    const amountCents: Centimes = toMinor(payout.amount, payoutCurrency);

    // Re-validate: a clawback/refund after the DRAFT snapshot can reduce the
    // actual eligible balance, so never pay out more than is currently available.
    const availableCents = await accountBalanceCents(tx, tenantId, "AVAILABLE", payoutCurrency);
    if (availableCents < amountCents) {
      throw new PayoutError("payout exceeds current eligible funds — recreate the payout");
    }

    await postEntry(
      tenantId,
      posting(
        debit("AVAILABLE", amountCents, "PAYOUT", null, payoutCurrency),
        credit("PAID_OUT", amountCents, "PAYOUT", null, payoutCurrency),
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
