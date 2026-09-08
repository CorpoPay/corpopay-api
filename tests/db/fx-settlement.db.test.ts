import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { planFxConversion } from "@/lib/fx-settlement";
import { convertForeignBalancesToSettlement } from "@/lib/fx-settlement-db";
import { credit, debit, posting } from "@/lib/ledger";
import { getTenantLedger, postEntry } from "@/lib/ledger-db";
import { centimes } from "@/lib/money";
import { createPayout } from "@/lib/payout-db";
import { prisma } from "@/lib/prisma";
import { makeTenant } from "../factories";

/**
 * Real-Postgres FX settlement suite (ADR 0006, phase 4). Verifies what a mock
 * cannot: a foreign AVAILABLE balance is swept into the tenant's settlement
 * currency, the explicit FX_ADJUSTMENT gain/loss is posted, and a payout created
 * against a foreign balance is denominated in the settlement currency.
 *
 * Run via `npm run test:db`.
 */

const TENANT = "fx-settlement-db-a";

async function seedEurAvailable(cents: number): Promise<void> {
  await postEntry(
    TENANT,
    posting(
      debit("CASH", centimes(cents), "CAPTURE", null, "EUR"),
      credit("AVAILABLE", centimes(cents), "CAPTURE", null, "EUR"),
    ),
  );
}

describe("fx settlement persistence (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "FX DB A", settlementCurrency: "MAD" }),
    });
  });

  afterAll(async () => {
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.payout.deleteMany({ where: { tenantId: TENANT } });
    await prisma.ledgerEntry.deleteMany({ where: { tenantId: TENANT } });
  });

  it("sweeps a foreign AVAILABLE balance into the settlement currency", async () => {
    await seedEurAvailable(1000); // 10.00 EUR

    const summary = await prisma.$transaction((tx) =>
      convertForeignBalancesToSettlement(tx, TENANT, "MAD"),
    );

    expect(summary).toHaveLength(1);
    expect(summary[0].from).toBe("EUR");
    expect(summary[0].to).toBe("MAD");
    expect(summary[0].amountFromMinor).toBe(1000);
    expect(summary[0].amountToMinor).toBe(11020); // 10.00 EUR × 11.02 = 110.20 MAD
    expect(summary[0].gainLossMinor).toBe(0); // sandbox: locked == reference

    const view = await getTenantLedger(TENANT);
    expect(view.balanced).toBe(true);
    expect(view.balancesByCurrency.EUR.AVAILABLE).toBe(0);
    expect(view.balancesByCurrency.MAD.AVAILABLE).toBe(11020);
  });

  it("posts an explicit FX_ADJUSTMENT for the reference-vs-locked gain", async () => {
    await seedEurAvailable(1000);

    const plan = planFxConversion({
      from: "EUR",
      to: "MAD",
      amountFromMinor: centimes(1000),
      lockedRate: "11.02000000", // tenant owed 110.20 MAD
      referenceRate: "11.20000000", // CorpoPay obtained 112.00 MAD
    });
    for (const p of plan.postings) {
      await postEntry(TENANT, p);
    }

    const view = await getTenantLedger(TENANT);
    expect(view.balanced).toBe(true);
    expect(view.balancesByCurrency.EUR.AVAILABLE).toBe(0);
    expect(view.balancesByCurrency.MAD.AVAILABLE).toBe(11020);
    expect(view.balancesByCurrency.MAD.FEES).toBe(180); // the FX_ADJUSTMENT gain
  });

  it("creates a settlement-currency payout from a foreign AVAILABLE balance", async () => {
    await seedEurAvailable(1000); // 10.00 EUR → 110.20 MAD after the FX sweep

    const payout = await createPayout(TENANT, { idempotencyKey: "fx-payout", provider: "VPS" });

    expect(payout.currency).toBe("MAD");
    expect(payout.amount.toString()).toBe("110.2");
  });
});
