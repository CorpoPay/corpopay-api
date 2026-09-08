/**
 * Wallet persistence + the settlement ledger wiring.
 *
 * A wallet is a customer stored-value account. Each operation both records a
 * signed `WalletTransaction` (the wallet's own audit trail) and posts balanced
 * double-entry `LedgerEntry` movements so the existing payout / reconciliation /
 * statement machinery sees wallet activity unchanged:
 *
 *   TOP_UP    — CASH → WALLET        (money already collected now held for the customer)
 *   DEBIT     — WALLET → AVAILABLE   (stored value becomes tenant earnings), then
 *               AVAILABLE → FEES     (CorpoPay commission)
 *   REFUND    — AVAILABLE → WALLET   (return earnings to the customer's stored value)
 *   ADJUSTMENT— WALLET ⇄ AVAILABLE   (manual correction, either direction)
 *
 * Money movement is serialized per tenant with `pg_advisory_xact_lock` (the same
 * lock `postEntry` uses), so the cached `Wallet.balance` snapshot can never be
 * lost to a concurrent update. Amounts cross this module's boundary as integer
 * centimes; the DB stores MAD `Decimal(12,2)` — every conversion goes through
 * `money.ts`.
 */
import type { Prisma, Wallet, WalletOwnerType, WalletTransaction } from "@/generated/prisma/client";
import { resolveFeeSpec } from "./fees-db";
import { getEffectiveWalletCommissionBasis } from "./finance-config-db";
import { credit as creditLeg, debit as debitLeg, posting } from "./ledger";
import { postEntry } from "./ledger-db";
import { type Centimes, type Currency, centimes, fromMinor, toMinor } from "./money";
import { prisma } from "./prisma";
import {
  debitWithFee,
  topUpWithFee,
  WalletError,
  type WalletMovement,
  adjustment as walletAdjustment,
  debit as walletDebit,
  refund as walletRefund,
  topUp as walletTopUp,
} from "./wallet";

export interface CreateWalletInput {
  ownerType: WalletOwnerType;
  ownerId: string;
  currency?: string | null;
}

export interface TopUpWalletInput {
  amountCents: Centimes;
  /** Optional linkage to the payment intent that charged the customer. */
  paymentIntentId?: string | null;
}

export interface DebitWalletInput {
  amountCents: Centimes;
  /** Payment method key for PER_METHOD fee schedules (e.g. "card", "wallet"). */
  method?: string | null;
}

export interface RefundWalletInput {
  amountCents: Centimes;
}

export interface AdjustWalletInput {
  /** Signed: positive credits the wallet, negative debits it. */
  amountCents: Centimes;
}

export type WalletWithTransactions = Wallet & { transactions: WalletTransaction[] };

export interface WalletOpResult {
  wallet: Wallet;
  transaction: WalletTransaction;
}

/** Create (or return the existing) wallet for a polymorphic owner, idempotently. */
export async function createWallet(tenantId: string, input: CreateWalletInput): Promise<Wallet> {
  return prisma.wallet.upsert({
    where: {
      tenantId_ownerType_ownerId: {
        tenantId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
      },
    },
    create: {
      tenantId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      currency: input.currency ?? "MAD",
      balance: 0,
      status: "ACTIVE",
    },
    update: {},
  });
}

export async function listWallets(tenantId: string): Promise<Wallet[]> {
  return prisma.wallet.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
}

export async function getWallet(
  tenantId: string,
  id: string,
): Promise<WalletWithTransactions | null> {
  return prisma.wallet.findFirst({
    where: { id, tenantId },
    include: { transactions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

/**
 * Serialize money movement for this tenant and load the wallet, rejecting a
 * missing or non-active wallet. Must be called inside a transaction; the
 * advisory lock is transaction-scoped and released on commit.
 */
async function loadActiveWallet(
  tx: Prisma.TransactionClient,
  tenantId: string,
  walletId: string,
): Promise<Wallet> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;
  const wallet = await tx.wallet.findFirst({ where: { id: walletId, tenantId } });
  if (!wallet) throw new WalletError("wallet not found", "WALLET_NOT_FOUND");
  if (wallet.status !== "ACTIVE")
    throw new WalletError("wallet is not active", "WALLET_NOT_ACTIVE");
  return wallet;
}

/** Persist a signed movement as a `WalletTransaction` + the updated balance snapshot. */
async function recordMovement(
  tx: Prisma.TransactionClient,
  tenantId: string,
  wallet: Wallet,
  type: WalletTransaction["type"],
  movement: WalletMovement,
  sourceType: string,
  sourceId: string,
): Promise<WalletOpResult> {
  const currency: Currency = wallet.currency as Currency;
  const transaction = await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      tenantId,
      type,
      amount: fromMinor(movement.signedAmountCents, currency),
      currency: wallet.currency,
      balanceAfter: fromMinor(movement.balanceAfterCents, currency),
      sourceType,
      sourceId,
    },
  });
  const updated = await tx.wallet.update({
    where: { id: wallet.id },
    data: { balance: fromMinor(movement.balanceAfterCents, currency) },
  });
  return { wallet: updated, transaction };
}

export async function topUpWallet(
  tenantId: string,
  id: string,
  input: TopUpWalletInput,
): Promise<WalletOpResult> {
  return prisma.$transaction(async (tx) => {
    const wallet = await loadActiveWallet(tx, tenantId, id);
    const currency: Currency = wallet.currency as Currency;
    const basis = await getEffectiveWalletCommissionBasis(tenantId, tx);

    if (basis === "load") {
      // Commission on load: collect gross, credit only the net stored value, and
      // take the fee out of the wallet (symmetrical to the usage-basis debit).
      const scheduleRow = await tx.feeSchedule.findFirst({ where: { tenantId, isActive: true } });
      const policyRow = await tx.settlementPolicy.findFirst({
        where: { tenantId, isActive: true },
      });
      const schedule = resolveFeeSpec(scheduleRow, policyRow?.industry ?? null);
      const movement = topUpWithFee(toMinor(wallet.balance, currency), input.amountCents, schedule);

      await postEntry(
        tenantId,
        posting(
          debitLeg("CASH", movement.grossCents, "CAPTURE", null, currency),
          creditLeg("WALLET", movement.grossCents, "CAPTURE", null, currency),
          { sourceType: "wallet", sourceId: wallet.id },
        ),
        tx,
      );
      if (movement.feeCents > 0) {
        await postEntry(
          tenantId,
          posting(
            debitLeg("WALLET", movement.feeCents, "FEE", null, currency),
            creditLeg("FEES", movement.feeCents, "FEE", null, currency),
            { sourceType: "wallet", sourceId: wallet.id },
          ),
          tx,
        );
      }

      const sourceType = input.paymentIntentId ? "payment_intent" : "wallet_topup";
      const sourceId = input.paymentIntentId ?? wallet.id;
      return recordMovement(tx, tenantId, wallet, "TOP_UP", movement, sourceType, sourceId);
    }

    // usage basis (default): no commission on load.
    const movement = walletTopUp(toMinor(wallet.balance, currency), input.amountCents);

    await postEntry(
      tenantId,
      posting(
        debitLeg("CASH", input.amountCents, "CAPTURE", null, currency),
        creditLeg("WALLET", input.amountCents, "CAPTURE", null, currency),
        { sourceType: "wallet", sourceId: wallet.id },
      ),
      tx,
    );

    const sourceType = input.paymentIntentId ? "payment_intent" : "wallet_topup";
    const sourceId = input.paymentIntentId ?? wallet.id;
    return recordMovement(tx, tenantId, wallet, "TOP_UP", movement, sourceType, sourceId);
  });
}

export async function debitWallet(
  tenantId: string,
  id: string,
  input: DebitWalletInput,
): Promise<WalletOpResult> {
  return prisma.$transaction(async (tx) => {
    const wallet = await loadActiveWallet(tx, tenantId, id);
    const currency: Currency = wallet.currency as Currency;
    const basis = await getEffectiveWalletCommissionBasis(tenantId, tx);

    if (basis === "load") {
      // Commission already taken on load: draw-down is free.
      const movement = walletDebit(toMinor(wallet.balance, currency), input.amountCents);
      await postEntry(
        tenantId,
        posting(
          debitLeg("WALLET", input.amountCents, "CAPTURE", null, currency),
          creditLeg("AVAILABLE", input.amountCents, "CAPTURE", null, currency),
          { sourceType: "wallet", sourceId: wallet.id },
        ),
        tx,
      );
      return recordMovement(tx, tenantId, wallet, "DEBIT", movement, "wallet_debit", wallet.id);
    }

    // usage basis (default): commission on draw-down.
    const scheduleRow = await tx.feeSchedule.findFirst({ where: { tenantId, isActive: true } });
    const policyRow = await tx.settlementPolicy.findFirst({
      where: { tenantId, isActive: true },
    });
    // Same shared fallback as card captures: explicit FeeSchedule wins, else the
    // tenant's industry preset fee — never a silent 0.
    const schedule = resolveFeeSpec(scheduleRow, policyRow?.industry ?? null);
    const movement = debitWithFee(
      toMinor(wallet.balance, currency),
      input.amountCents,
      schedule,
      input.method ?? undefined,
    );

    // Release customer stored value into tenant earnings.
    await postEntry(
      tenantId,
      posting(
        debitLeg("WALLET", input.amountCents, "CAPTURE", null, currency),
        creditLeg("AVAILABLE", input.amountCents, "CAPTURE", null, currency),
        { sourceType: "wallet", sourceId: wallet.id },
      ),
      tx,
    );

    // CorpoPay commission out of those earnings.
    if (movement.feeCents > 0) {
      await postEntry(
        tenantId,
        posting(
          debitLeg("AVAILABLE", movement.feeCents, "FEE", null, currency),
          creditLeg("FEES", movement.feeCents, "FEE", null, currency),
          { sourceType: "wallet", sourceId: wallet.id },
        ),
        tx,
      );
    }

    return recordMovement(tx, tenantId, wallet, "DEBIT", movement, "wallet_debit", wallet.id);
  });
}

export async function refundWallet(
  tenantId: string,
  id: string,
  input: RefundWalletInput,
): Promise<WalletOpResult> {
  return prisma.$transaction(async (tx) => {
    const wallet = await loadActiveWallet(tx, tenantId, id);
    const currency: Currency = wallet.currency as Currency;
    const movement = walletRefund(toMinor(wallet.balance, currency), input.amountCents);

    await postEntry(
      tenantId,
      posting(
        debitLeg("AVAILABLE", input.amountCents, "REFUND", null, currency),
        creditLeg("WALLET", input.amountCents, "REFUND", null, currency),
        { sourceType: "wallet", sourceId: wallet.id },
      ),
      tx,
    );

    return recordMovement(tx, tenantId, wallet, "REFUND", movement, "wallet_refund", wallet.id);
  });
}

export async function adjustWallet(
  tenantId: string,
  id: string,
  input: AdjustWalletInput,
): Promise<WalletOpResult> {
  const signed = input.amountCents;
  return prisma.$transaction(async (tx) => {
    const wallet = await loadActiveWallet(tx, tenantId, id);
    const currency: Currency = wallet.currency as Currency;
    const movement = walletAdjustment(toMinor(wallet.balance, currency), signed);
    const abs = centimes(Math.abs(signed));

    if (signed > 0) {
      // Credit the wallet out of the tenant's balance sheet.
      await postEntry(
        tenantId,
        posting(
          debitLeg("AVAILABLE", abs, "ADJUSTMENT", null, currency),
          creditLeg("WALLET", abs, "ADJUSTMENT", null, currency),
          {
            sourceType: "wallet",
            sourceId: wallet.id,
          },
        ),
        tx,
      );
    } else if (signed < 0) {
      // Debit the wallet into the tenant's balance sheet.
      await postEntry(
        tenantId,
        posting(
          debitLeg("WALLET", abs, "ADJUSTMENT", null, currency),
          creditLeg("AVAILABLE", abs, "ADJUSTMENT", null, currency),
          {
            sourceType: "wallet",
            sourceId: wallet.id,
          },
        ),
        tx,
      );
    }

    return recordMovement(tx, tenantId, wallet, "ADJUSTMENT", movement, "wallet_adjust", wallet.id);
  });
}
