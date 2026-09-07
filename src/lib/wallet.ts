/**
 * Wallet / stored-value engine (PayFac prepaid model) — pure, centime-exact math.
 *
 * A `Wallet` is a customer stored-value account: money is topped up ahead of use,
 * then drawn down later (the OtoParking prepaid model) with no per-transaction
 * provider call. The tenant earns the draw-down amount; CorpoPay takes a
 * commission via the active `FeeSchedule`.
 *
 * Balance convention: the wallet balance is **derived** from the signed amounts
 * of its transactions — `Σ signedAmountCents`, where a positive amount credits
 * the wallet (TOP_UP / REFUND / a positive ADJUSTMENT) and a negative amount
 * debits it (DEBIT / a negative ADJUSTMENT). The `balanceAfter` field carried on
 * each transaction is a running snapshot for audit; the derived sum is the
 * authoritative balance.
 *
 * Everything here is pure and side-effect-free, so it is property-testable.
 * Persistence (`wallet-db.ts`) wraps these helpers and posts the matching
 * double-entry ledger movements. Amounts cross the boundary as integer centimes
 * (`Centimes`); the DB stores MAD `Decimal(12,2)` — every conversion goes through
 * `money.ts`.
 */
import type { FeeScheduleSpec } from "./fees";
import { computeFee } from "./fees";
import { type Centimes, centimes } from "./money";

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: string = "WALLET_ERROR",
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** A zero-fee schedule — used when no active fee schedule is configured. */
export const ZERO_FEE_SCHEDULE: FeeScheduleSpec = {
  feeType: "FLAT",
  flatCents: 0,
  percentageBps: null,
  perMethodCents: null,
  tiersCents: null,
};

export interface WalletMovement {
  /** Signed movement: positive credits the wallet, negative debits it. */
  signedAmountCents: Centimes;
  /** Balance after applying the movement. */
  balanceAfterCents: Centimes;
}

export interface WalletDebit extends WalletMovement {
  /** CorpoPay commission (centimes) taken on this draw-down. */
  feeCents: Centimes;
  /** Tenant earnings after commission: `amount − fee`. */
  netCents: Centimes;
}

/** Derive a wallet balance from a list of signed amounts (Σ). */
export function computeBalance(signedAmountCents: readonly Centimes[]): Centimes {
  return centimes(signedAmountCents.reduce((a, b) => a + b, 0));
}

/** Apply a signed movement to a balance (pure). */
export function applyMovement(balanceCents: Centimes, signedAmountCents: Centimes): Centimes {
  return centimes(balanceCents + signedAmountCents);
}

/** Credit the wallet (top-up). `amountCents` must be positive. */
export function topUp(balanceCents: Centimes, amountCents: Centimes): WalletMovement {
  if (amountCents <= 0)
    throw new WalletError("top-up amount must be positive", "WALLET_INVALID_AMOUNT");
  return {
    signedAmountCents: amountCents,
    balanceAfterCents: applyMovement(balanceCents, amountCents),
  };
}

/**
 * Debit the wallet (draw-down). `amountCents` must be positive and not exceed the
 * balance. Returns a negative `signedAmountCents`.
 */
export function debit(balanceCents: Centimes, amountCents: Centimes): WalletMovement {
  if (amountCents <= 0)
    throw new WalletError("debit amount must be positive", "WALLET_INVALID_AMOUNT");
  if (amountCents > balanceCents) {
    throw new WalletError("insufficient wallet balance", "WALLET_INSUFFICIENT_BALANCE");
  }
  const signedAmountCents = centimes(-amountCents);
  return {
    signedAmountCents,
    balanceAfterCents: applyMovement(balanceCents, signedAmountCents),
  };
}

/**
 * Debit the wallet and compute the CorpoPay commission in one step. `netCents` is
 * the tenant's earnings (`amount − fee`); a flat fee may exceed a tiny amount, so
 * `netCents` can be negative (mirrors `netAfterFee`, the caller's concern).
 */
export function debitWithFee(
  balanceCents: Centimes,
  amountCents: Centimes,
  schedule: FeeScheduleSpec,
  method?: string,
): WalletDebit {
  const feeCents = computeFee(schedule, amountCents, method);
  const movement = debit(balanceCents, amountCents);
  return {
    ...movement,
    feeCents,
    netCents: centimes(amountCents - feeCents),
  };
}

/** Credit the wallet (return stored value). `amountCents` must be positive. */
export function refund(balanceCents: Centimes, amountCents: Centimes): WalletMovement {
  if (amountCents <= 0)
    throw new WalletError("refund amount must be positive", "WALLET_INVALID_AMOUNT");
  return {
    signedAmountCents: amountCents,
    balanceAfterCents: applyMovement(balanceCents, amountCents),
  };
}

/**
 * Manual correction. `signedAmountCents` is positive to credit, negative to debit.
 * The resulting balance must stay non-negative.
 */
export function adjustment(balanceCents: Centimes, signedAmountCents: Centimes): WalletMovement {
  const balanceAfterCents = applyMovement(balanceCents, signedAmountCents);
  if (balanceAfterCents < 0) {
    throw new WalletError("adjustment would overdraw the wallet", "WALLET_INSUFFICIENT_BALANCE");
  }
  return { signedAmountCents, balanceAfterCents };
}
