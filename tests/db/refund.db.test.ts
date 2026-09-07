import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Provider } from "@/generated/prisma/client";

import { createFeeSchedule } from "@/lib/fees-db";
import { getTenantLedger } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { createPayout, markPayoutPaid } from "@/lib/payout-db";
import { createSettlementPolicy } from "@/lib/policy-db";
import { prisma } from "@/lib/prisma";
import { settleRefund } from "@/lib/refund-db";
import { settleCapture } from "@/lib/settlement-db";
import { makeTenant } from "../factories";

/**
 * Real-Postgres refund-clawback suite. Proves a full refund unwinds the capture's
 * settlement (net + fee + reserve → CASH), is idempotent, and refuses to over-draw
 * AVAILABLE once the net has already been paid out.
 *
 * Run via `npm run test:db` (the only real-DB path — `npm test` excludes this).
 */

const TENANT = "refund-db";

async function expectBalanced() {
  const view = await getTenantLedger(TENANT);
  expect(view.balanced).toBe(true);
  const total = Object.values(view.balances).reduce((a, b) => a + b, 0);
  expect(total).toBe(0);
  return view;
}

describe("refund settlement (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.recovery.deleteMany({ where: { tenantId: TENANT } });
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Refund DB" }),
    });
  });

  afterAll(async () => {
    await prisma.recovery.deleteMany({ where: { tenantId: TENANT } });
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.recovery.deleteMany({ where: { tenantId: TENANT } });
    await prisma.dispute.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("unwinds a capture's settlement (net + fee + reserve → CASH)", async () => {
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { industry: "retail" }); // 3% rolling reserve

    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(10000) });
    const afterCapture = await expectBalanced();
    expect(afterCapture.balances.CASH).toBe(-10000);
    expect(afterCapture.balances.AVAILABLE).toBe(9410);

    const { settled } = await settleRefund(TENANT, { intentId: "pi-1", refundId: "ref-1" });
    expect(settled).toBe(true);

    const view = await expectBalanced();
    expect(view.balances.CASH).toBe(0); // fully unwound
    expect(view.balances.AVAILABLE).toBe(0);
    expect(view.balances.FEES).toBe(0);
    expect(view.balances.RESERVE).toBe(0);
  });

  it("is idempotent — a replay does not double-claw", async () => {
    await createFeeSchedule(TENANT, { feeType: "FLAT", flatCents: 0 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(5000) });
    const first = await settleRefund(TENANT, { intentId: "pi-1", refundId: "ref-1" });
    expect(first.settled).toBe(true);

    const second = await settleRefund(TENANT, { intentId: "pi-1", refundId: "ref-1" });
    expect(second.settled).toBe(false);

    const view = await expectBalanced();
    expect(view.balances.CASH).toBe(0);
  });

  it("refuses to over-draw AVAILABLE when the net was already paid out", async () => {
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(10000) });
    const payout = await createPayout(TENANT, { idempotencyKey: "po-1", provider: Provider.VPS });
    await markPayoutPaid(TENANT, payout.id, "xfer-1");

    await expect(settleRefund(TENANT, { intentId: "pi-1", refundId: "ref-1" })).rejects.toThrow(
      /over-draw AVAILABLE/,
    );
  });
});
