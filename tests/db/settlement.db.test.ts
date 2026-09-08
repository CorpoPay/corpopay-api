import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Provider, WalletOwnerType } from "@/generated/prisma/client";

import { createFeeSchedule } from "@/lib/fees-db";
import { getTenantLedger } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { createPayout, markPayoutPaid } from "@/lib/payout-db";
import { createSettlementPolicy } from "@/lib/policy-db";
import { prisma } from "@/lib/prisma";
import { createDispute, resolveDispute } from "@/lib/reversals-db";
import { settleCapture } from "@/lib/settlement-db";
import { createSplitParty, createSplitRule } from "@/lib/splits-db";
import { createWallet, debitWallet, topUpWallet } from "@/lib/wallet-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres capture-settlement suite. This is the end-to-end proof for the
 * money path: `settleCapture` is the entry point that funds a tenant's AVAILABLE
 * balance for card captures, and the double-entry invariant (Σ debits = Σ credits,
 * i.e. every account sums to zero) holds through capture → fee → reserve →
 * availability → payout → dispute → wallet.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "settlement-db";

/** Assert the global double-entry invariant after a set of transitions. */
async function expectBalanced() {
  const view = await getTenantLedger(TENANT);
  expect(view.balanced).toBe(true);
  const total = Object.values(view.balances).reduce((a, b) => a + b, 0);
  expect(total).toBe(0);
  return view;
}

describe("capture settlement (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.recovery.deleteMany({ where: { tenantId: TENANT } });
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.walletTransaction.deleteMany({ where: { tenantId: TENANT } });
    await prisma.wallet.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Settlement DB" }),
    });
  });

  afterAll(async () => {
    await prisma.recovery.deleteMany({ where: { tenantId: TENANT } });
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.walletTransaction.deleteMany({ where: { tenantId: TENANT } });
    await prisma.wallet.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.split.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitParty.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.recovery.deleteMany({ where: { tenantId: TENANT } });
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.walletTransaction.deleteMany({ where: { tenantId: TENANT } });
    await prisma.wallet.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.split.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitRule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.splitParty.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.update({
      where: { id: TENANT },
      data: { taxRateBps: 0, taxExempt: false },
    });
  });

  it("settles a capture into CASH → COLLECTED → FEES/RESERVE/AVAILABLE, net-zero", async () => {
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { industry: "retail" }); // 3% rolling reserve

    const { settled } = await settleCapture(TENANT, {
      intentId: "pi-1",
      amountCents: centimes(10000),
    });
    expect(settled).toBe(true);

    const view = await expectBalanced();
    expect(view.balances.CASH).toBe(-10000);
    expect(view.balances.COLLECTED).toBe(0);
    expect(view.balances.FEES).toBe(290); // 2.9%
    expect(view.balances.RESERVE).toBe(300); // 3%
    expect(view.balances.AVAILABLE).toBe(9410); // 100.00 − 2.90 − 3.00
  });

  it("collects tax on the fee into TAX_PAYABLE and reduces AVAILABLE", async () => {
    await prisma.tenant.update({
      where: { id: TENANT },
      data: { taxRateBps: 2000, taxExempt: false }, // 20% VAT on CorpoPay's fee
    });
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    const { settled } = await settleCapture(TENANT, {
      intentId: "pi-tax",
      amountCents: centimes(10000),
    });
    expect(settled).toBe(true);

    const view = await expectBalanced();
    expect(view.balances.FEES).toBe(290); // 2.9%
    expect(view.balances.TAX_PAYABLE).toBe(58); // 20% of 2.90
    expect(view.balances.AVAILABLE).toBe(9652); // 100.00 − 2.90 − 0.58
  });

  it("adds no tax when the tenant is exempt (reverse-charge)", async () => {
    await prisma.tenant.update({
      where: { id: TENANT },
      data: { taxRateBps: 2000, taxExempt: true },
    });
    await createFeeSchedule(TENANT, { feeType: "FLAT", flatCents: 100 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    const { settled } = await settleCapture(TENANT, {
      intentId: "pi-tax-exempt",
      amountCents: centimes(5000),
    });
    expect(settled).toBe(true);

    const view = await expectBalanced();
    expect(view.balances.TAX_PAYABLE).toBe(0);
    expect(view.balances.AVAILABLE).toBe(4900); // 50.00 − 1.00 flat
  });

  it("is idempotent — a replay never double-books", async () => {
    await createFeeSchedule(TENANT, { feeType: "FLAT", flatCents: 100 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    const first = await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(5000) });
    expect(first.settled).toBe(true);
    const second = await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(5000) });
    expect(second.settled).toBe(false);

    const view = await expectBalanced();
    expect(view.balances.AVAILABLE).toBe(4900); // 50.00 − 1.00 flat
    expect(view.entries).toHaveLength(6); // gross + fee + net (2 legs each; reserve=0 skipped)
  });

  it("applies the default preset (2.9% fee + 5% reserve) when unconfigured", async () => {
    const { settled } = await settleCapture(TENANT, {
      intentId: "pi-1",
      amountCents: centimes(7000),
    });
    expect(settled).toBe(true);

    const view = await expectBalanced();
    expect(view.balances.FEES).toBe(203); // 2.9% of 70.00
    expect(view.balances.RESERVE).toBe(350); // 5% of 70.00
    expect(view.balances.AVAILABLE).toBe(6447); // 70.00 − 2.03 − 3.50
    expect(view.balances.CASH).toBe(-7000);
  });

  it("charges the preset fee on a wallet draw-down with no explicit FeeSchedule", async () => {
    // No FeeSchedule and no SettlementPolicy → the default 2.9% preset applies.
    const wallet = await createWallet(TENANT, {
      ownerType: WalletOwnerType.CUSTOMER,
      ownerId: "cust-preset",
    });
    await topUpWallet(TENANT, wallet.id, { amountCents: centimes(5000) });
    await debitWallet(TENANT, wallet.id, { amountCents: centimes(2000) });

    const view = await expectBalanced();
    expect(view.balances.WALLET).toBe(3000); // 30.00 MAD retained
    expect(view.balances.FEES).toBe(58); // 2.9% of 20.00
    expect(view.balances.AVAILABLE).toBe(1942); // 20.00 − 0.58
  });

  it("splits a capture on the gross and funds fee+reserve from the platform remainder", async () => {
    const party = await createSplitParty(TENANT, { slug: "host", name: "Host" });
    await createSplitRule(TENANT, {
      name: "Marketplace",
      shares: [{ partyId: party.id, shareBps: 8000 }], // host 80%, platform 20%
    });
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { splittingEnabled: true, reserveType: "NONE" });

    const { settled } = await settleCapture(TENANT, {
      intentId: "pi-split",
      amountCents: centimes(10000), // 100.00 MAD gross
    });
    expect(settled).toBe(true);

    const view = await expectBalanced();
    // Host gets 80.00 MAD untouched; the platform remainder (20.00 MAD) is charged
    // 2.9% → 0.58 MAD — the fee is computed on the remainder, not the gross.
    expect(view.balances.CASH).toBe(-10000);
    expect(view.balances.COLLECTED).toBe(0);
    expect(view.balances.FEES).toBe(58); // 2.9% of 20.00
    expect(view.balances.RESERVE).toBe(0);
    expect(view.balances.AVAILABLE).toBe(9942); // 80.00 host + 19.42 platform

    const splits = await prisma.split.findMany({ where: { tenantId: TENANT } });
    expect(splits).toHaveLength(1);
    expect(splits[0].amount.toString()).toBe("80");
  });

  it("keeps the ledger balanced across capture → payout → dispute → wallet", async () => {
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    // Capture: 100.00 MAD → 97.10 available (2.9% fee).
    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(10000) });
    const afterCapture = await expectBalanced();
    expect(afterCapture.balances.AVAILABLE).toBe(9710);

    // Payout: AVAILABLE → PAID_OUT.
    const payout = await createPayout(TENANT, { idempotencyKey: "po-1", provider: Provider.VPS });
    await markPayoutPaid(TENANT, payout.id, "vps-xfer-1");
    const afterPayout = await expectBalanced();
    expect(afterPayout.balances.AVAILABLE).toBe(0);
    expect(afterPayout.balances.PAID_OUT).toBe(9710);

    // A lost dispute with no remaining AVAILABLE becomes a recovery receivable
    // (tracked outside the ledger) — no money is created, the ledger stays flat.
    const dispute = await createDispute(TENANT, {
      providerDisputeId: "disp-1",
      provider: Provider.VPS,
      amountCents: centimes(2000),
    });
    await resolveDispute(TENANT, dispute.id, "LOST");
    await expectBalanced();

    // Wallet top-up (CASH → WALLET) then draw-down (WALLET → AVAILABLE → FEES).
    const wallet = await createWallet(TENANT, {
      ownerType: WalletOwnerType.CUSTOMER,
      ownerId: "cust-1",
    });
    await topUpWallet(TENANT, wallet.id, { amountCents: centimes(3000) });
    await debitWallet(TENANT, wallet.id, { amountCents: centimes(2000) });

    const final = await expectBalanced();
    // Sanity: the wallet retains 10.00 MAD of stored value.
    expect(final.balances.WALLET).toBe(1000);
    // And the tenant earned the draw-down net of fee (20.00 − 0.58).
    expect(final.balances.AVAILABLE).toBe(1942);
  });
});
