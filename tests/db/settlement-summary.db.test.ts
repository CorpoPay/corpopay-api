import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Provider } from "@/generated/prisma/client";

import { createFeeSchedule } from "@/lib/fees-db";
import { centimes } from "@/lib/money";
import { createPayout } from "@/lib/payout-db";
import { createSettlementPolicy } from "@/lib/policy-db";
import { prisma } from "@/lib/prisma";
import { settleCapture } from "@/lib/settlement-db";
import { getSettlementSummary } from "@/lib/settlement-summary-db";
import { makeTenant } from "../factories";

const TENANT = "settlement-summary-db";

async function cleanup() {
  await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
  await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
  await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
  await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
}

describe("settlement summary (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await cleanup();
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Settlement Summary DB" }),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(cleanup);

  it("reports net owed = available, with the fee/reserve breakdown and MANUAL rail", async () => {
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { industry: "retail" }); // 3% rolling reserve

    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(10000) });
    // available = 100.00 − 2.90 − 3.00 = 94.10 MAD → 9410 centimes

    const { summary, payoutRail } = await getSettlementSummary(TENANT);
    expect(summary.availableCents).toBe(9410);
    expect(summary.feesCents).toBe(290);
    expect(summary.reserveCents).toBe(300);
    expect(summary.paidOutCents).toBe(0);
    expect(summary.scheduledCents).toBe(0);
    expect(summary.eligibleCents).toBe(9410);
    expect(payoutRail).toBe("MANUAL");
  });

  it("subtracts open payouts from eligible", async () => {
    await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE" });

    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(10000) }); // 97.10 avail
    await createPayout(TENANT, { idempotencyKey: "po-1", provider: Provider.VPS }); // DRAFT reserves all

    const { summary } = await getSettlementSummary(TENANT);
    expect(summary.availableCents).toBe(9710);
    expect(summary.scheduledCents).toBe(9710);
    expect(summary.eligibleCents).toBe(0);
  });

  it("resolves STRIPE_CONNECT from the active policy", async () => {
    await createFeeSchedule(TENANT, { feeType: "FLAT", flatCents: 0 });
    await createSettlementPolicy(TENANT, { reserveType: "NONE", payoutRail: "STRIPE_CONNECT" });

    await settleCapture(TENANT, { intentId: "pi-1", amountCents: centimes(10000) });
    const { summary, payoutRail } = await getSettlementSummary(TENANT);
    expect(payoutRail).toBe("STRIPE_CONNECT");
    expect(summary.availableCents).toBe(10000);
  });
});
