import { Router } from "express";
import type { Wallet, WalletTransaction } from "@/generated/prisma/client";
import { requireCapability } from "../lib/finance-config-db";
import { centimes, madToCentimes } from "../lib/money";
import { WalletError } from "../lib/wallet";
import {
  adjustWallet,
  createWallet,
  debitWallet,
  getWallet,
  listWallets,
  refundWallet,
  topUpWallet,
} from "../lib/wallet-db";
import { requireAuth, requireOwner } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import {
  adjustWalletSchema,
  createWalletSchema,
  debitWalletSchema,
  refundWalletSchema,
  topUpWalletSchema,
} from "../schemas/wallets";

const router = Router();

function toWalletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    tenantId: wallet.tenantId,
    ownerType: wallet.ownerType,
    ownerId: wallet.ownerId,
    balanceCents: madToCentimes(wallet.balance),
    currency: wallet.currency,
    status: wallet.status,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toTransactionResponse(tx: WalletTransaction) {
  return {
    id: tx.id,
    type: tx.type,
    amountCents: madToCentimes(tx.amount),
    currency: tx.currency,
    balanceAfterCents: madToCentimes(tx.balanceAfter),
    sourceType: tx.sourceType,
    sourceId: tx.sourceId,
    createdAt: tx.createdAt,
  };
}

/** Map a pure `WalletError` onto the right HTTP status. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WalletError) {
      const status =
        err.code === "WALLET_NOT_FOUND"
          ? 404
          : err.code === "WALLET_NOT_ACTIVE" || err.code === "WALLET_INSUFFICIENT_BALANCE"
            ? 409
            : 400;
      throw new AppError(status, err.code, err.message);
    }
    throw err;
  }
}

// ─── POST /wallets ────────────────────────────────────────────────────────────────

router.post(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = createWalletSchema.parse(req.body);
    await requireCapability(req.user!.tenantId, "WALLET");
    const wallet = await run(() => createWallet(req.user!.tenantId, input));
    res.status(201).json(toWalletResponse(wallet));
  }),
);

// ─── GET /wallets ─────────────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const wallets = await listWallets(req.user!.tenantId);
    res.json(wallets.map(toWalletResponse));
  }),
);

// ─── GET /wallets/:id ─────────────────────────────────────────────────────────────

router.get(
  "/:id",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const wallet = await getWallet(req.user!.tenantId, req.params.id);
    if (!wallet) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
    res.json({
      ...toWalletResponse(wallet),
      transactions: wallet.transactions.map(toTransactionResponse),
    });
  }),
);

// ─── POST /wallets/:id/topup ──────────────────────────────────────────────────────

router.post(
  "/:id/topup",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = topUpWalletSchema.parse(req.body);
    const result = await run(() =>
      topUpWallet(req.user!.tenantId, req.params.id, {
        amountCents: centimes(input.amountCents),
        paymentIntentId: input.paymentIntentId,
      }),
    );
    res.json({
      ...toWalletResponse(result.wallet),
      transaction: toTransactionResponse(result.transaction),
    });
  }),
);

// ─── POST /wallets/:id/debit ──────────────────────────────────────────────────────

router.post(
  "/:id/debit",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = debitWalletSchema.parse(req.body);
    const result = await run(() =>
      debitWallet(req.user!.tenantId, req.params.id, {
        amountCents: centimes(input.amountCents),
        method: input.method,
      }),
    );
    res.json({
      ...toWalletResponse(result.wallet),
      transaction: toTransactionResponse(result.transaction),
    });
  }),
);

// ─── POST /wallets/:id/refund ─────────────────────────────────────────────────────

router.post(
  "/:id/refund",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = refundWalletSchema.parse(req.body);
    const result = await run(() =>
      refundWallet(req.user!.tenantId, req.params.id, { amountCents: centimes(input.amountCents) }),
    );
    res.json({
      ...toWalletResponse(result.wallet),
      transaction: toTransactionResponse(result.transaction),
    });
  }),
);

// ─── POST /wallets/:id/adjust ─────────────────────────────────────────────────────

router.post(
  "/:id/adjust",
  requireAuth,
  requireOwner,
  asyncHandler(async (req, res) => {
    const input = adjustWalletSchema.parse(req.body);
    const result = await run(() =>
      adjustWallet(req.user!.tenantId, req.params.id, { amountCents: centimes(input.amountCents) }),
    );
    res.json({
      ...toWalletResponse(result.wallet),
      transaction: toTransactionResponse(result.transaction),
    });
  }),
);

export default router;
