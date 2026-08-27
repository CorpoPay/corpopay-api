/**
 * Split persistence + the split/release ledger postings.
 *
 * `executeSplit` divides a source amount into beneficiary shares + a platform
 * remainder, writing one `Split` row per beneficiary and posting the balanced
 * ledger movement for each share (debit the source account, credit the party's
 * AVAILABLE or RESERVE). `releaseSplit` moves a held share RESERVE → AVAILABLE
 * when the escrow condition is met (e.g. OtoParking's "booking completed").
 *
 * Amounts cross this boundary as integer centimes; the DB stores MAD
 * `Decimal(12,2)` — every conversion goes through `money.ts`.
 */
import type {
  Prisma,
  Split,
  SplitParty,
  SplitPartyType,
  SplitRule,
  SplitTrigger,
} from "@/generated/prisma/client";

import { credit, debit, posting } from "./ledger";
import { postEntry } from "./ledger-db";
import { type Centimes, centimesToMad, madToCentimes } from "./money";
import { prisma } from "./prisma";
import {
  assertTransition,
  type ShareSpec,
  SplitError,
  sourceAccountFor,
  split,
  validateShares,
} from "./splits";

// ─── Split parties ─────────────────────────────────────────────────────────────

export interface CreateSplitPartyInput {
  slug: string;
  name: string;
  type?: SplitPartyType;
}

export async function createSplitParty(
  tenantId: string,
  input: CreateSplitPartyInput,
): Promise<SplitParty> {
  return prisma.splitParty.create({
    data: {
      tenantId,
      slug: input.slug,
      name: input.name,
      type: input.type ?? "SUB_MERCHANT",
    },
  });
}

export async function listSplitParties(tenantId: string): Promise<SplitParty[]> {
  return prisma.splitParty.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
  });
}

export async function getSplitParty(tenantId: string, id: string): Promise<SplitParty | null> {
  return prisma.splitParty.findFirst({ where: { id, tenantId } });
}

export async function deactivateSplitParty(tenantId: string, id: string): Promise<SplitParty> {
  const party = await prisma.splitParty.findFirst({ where: { id, tenantId } });
  if (!party) throw new SplitError("split party not found");
  return prisma.splitParty.update({ where: { id }, data: { isActive: false } });
}

// ─── Split rules ───────────────────────────────────────────────────────────────

export interface CreateSplitRuleInput {
  name: string;
  trigger?: SplitTrigger;
  shares: ShareSpec[];
}

export async function createSplitRule(
  tenantId: string,
  input: CreateSplitRuleInput,
): Promise<SplitRule> {
  validateShares(input.shares);
  return prisma.splitRule.create({
    data: {
      tenantId,
      name: input.name,
      trigger: input.trigger ?? "AT_CAPTURE",
      shares: input.shares as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function listSplitRules(tenantId: string): Promise<SplitRule[]> {
  return prisma.splitRule.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
  });
}

export async function getSplitRule(tenantId: string, id: string): Promise<SplitRule | null> {
  return prisma.splitRule.findFirst({ where: { id, tenantId } });
}

export async function deactivateSplitRule(tenantId: string, id: string): Promise<SplitRule> {
  const rule = await prisma.splitRule.findFirst({ where: { id, tenantId } });
  if (!rule) throw new SplitError("split rule not found");
  return prisma.splitRule.update({ where: { id }, data: { isActive: false } });
}

// ─── Split execution ───────────────────────────────────────────────────────────

export interface ExecuteSplitInput {
  sourceType: string;
  sourceId: string;
  sourceCents: Centimes;
  /** Use a stored rule (its trigger + shares). */
  splitRuleId?: string | null;
  /** Inline rule (when `splitRuleId` is omitted). */
  trigger?: SplitTrigger;
  shares?: ShareSpec[];
  /** Hold beneficiary shares in RESERVE (escrow) instead of AVAILABLE. */
  held?: boolean;
  heldUntil?: Date | null;
}

/**
 * Divide a source into beneficiary shares + a platform remainder, posting the
 * ledger movement and writing one `Split` row per beneficiary atomically.
 *
 * - AT_CAPTURE: each share debits COLLECTED; the platform remainder also moves
 *   COLLECTED → AVAILABLE.
 * - ON_USAGE/MANUAL: each share debits AVAILABLE; the platform remainder stays
 *   in place (it is already the tenant's available balance).
 */
export async function executeSplit(tenantId: string, input: ExecuteSplitInput): Promise<Split[]> {
  let trigger: SplitTrigger;
  let shares: ShareSpec[];

  if (input.splitRuleId) {
    const rule = await prisma.splitRule.findFirst({ where: { id: input.splitRuleId, tenantId } });
    if (!rule) throw new SplitError("split rule not found");
    trigger = rule.trigger;
    shares = rule.shares as unknown as ShareSpec[];
  } else {
    trigger = input.trigger ?? "AT_CAPTURE";
    shares = input.shares ?? [];
  }

  const result = split(input.sourceCents, shares);
  const sourceAccount = sourceAccountFor(trigger);
  const held = input.held ?? false;
  const beneficiaryAccount = held ? "RESERVE" : "AVAILABLE";

  return prisma.$transaction(async (tx) => {
    const created: Split[] = [];

    for (const allocation of result.shares) {
      await postEntry(
        tenantId,
        posting(
          debit(sourceAccount, allocation.amountCents, "SPLIT"),
          credit(beneficiaryAccount, allocation.amountCents, "SPLIT", allocation.partyId),
          { sourceType: input.sourceType, sourceId: input.sourceId },
        ),
        tx,
      );
      created.push(
        await tx.split.create({
          data: {
            tenantId,
            splitRuleId: input.splitRuleId ?? null,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            partyId: allocation.partyId,
            amount: centimesToMad(allocation.amountCents),
            currency: "MAD",
            status: held ? "PENDING" : "SETTLED",
            heldUntil: held ? (input.heldUntil ?? null) : null,
          },
        }),
      );
    }

    // The platform remainder: only AT_CAPTURE moves it (COLLECTED → AVAILABLE);
    // ON_USAGE/MANUAL leaves it in the tenant's existing AVAILABLE balance.
    if (trigger === "AT_CAPTURE" && result.platformCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debit(sourceAccount, result.platformCents, "SPLIT"),
          credit("AVAILABLE", result.platformCents, "SPLIT"),
          { sourceType: input.sourceType, sourceId: input.sourceId },
        ),
        tx,
      );
    }

    return created;
  });
}

export async function listSplits(
  tenantId: string,
  filter?: { sourceType?: string; sourceId?: string },
): Promise<Split[]> {
  return prisma.split.findMany({
    where: { tenantId, ...filter },
    orderBy: { createdAt: "desc" },
  });
}

export async function getSplit(tenantId: string, id: string): Promise<Split | null> {
  return prisma.split.findFirst({ where: { id, tenantId } });
}

/**
 * Release a held split: move its share RESERVE → AVAILABLE and settle the row.
 * This is the escrow-release step (OtoParking "booking completed" / Jabadoor
 * "check-in" / a delayed availability window elapsing).
 */
export async function releaseSplit(tenantId: string, id: string): Promise<Split> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.split.findFirst({ where: { id, tenantId } });
    if (!existing) throw new SplitError("split not found");
    assertTransition(existing.status, "SETTLED");

    const amountCents = madToCentimes(existing.amount);
    await postEntry(
      tenantId,
      posting(
        debit("RESERVE", amountCents, "RESERVE_RELEASE", existing.partyId),
        credit("AVAILABLE", amountCents, "RESERVE_RELEASE", existing.partyId),
        { sourceType: "split", sourceId: id },
      ),
      tx,
    );

    return tx.split.update({
      where: { id },
      data: { status: "SETTLED", heldUntil: null },
    });
  });
}
