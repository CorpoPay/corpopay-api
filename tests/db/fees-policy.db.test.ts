import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFeeSchedule, getActiveFeeSchedule, listFeeSchedules } from "@/lib/fees-db";
import {
  createSettlementPolicy,
  getActiveSettlementPolicy,
  listSettlementPolicies,
} from "@/lib/policy-db";
import { prisma } from "@/lib/prisma";
import { makeTenant } from "../factories";

/**
 * Real-Postgres fee + policy suite. Verifies what a mock cannot: versioned
 * activation (only one active version per tenant), the `@@unique([tenantId,
 * version])` bump, and preset resolution at write time.
 */

const TENANT = "fees-policy-db";

describe("fee schedules + settlement policies (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Fees Policy DB" }),
    });
  });

  afterAll(async () => {
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.settlementPolicy.deleteMany({ where: { tenantId: TENANT } });
    await prisma.feeSchedule.deleteMany({ where: { tenantId: TENANT } });
  });

  it("creates versioned, active fee schedules (only one active)", async () => {
    const fs1 = await createFeeSchedule(TENANT, { feeType: "FLAT", flatCents: 250 });
    expect(fs1.version).toBe(1);
    expect(fs1.isActive).toBe(true);

    const fs2 = await createFeeSchedule(TENANT, { feeType: "PERCENTAGE", percentageBps: 290 });
    expect(fs2.version).toBe(2);
    expect(fs2.isActive).toBe(true);

    const active = await getActiveFeeSchedule(TENANT);
    expect(active?.id).toBe(fs2.id);

    const all = await listFeeSchedules(TENANT);
    expect(all).toHaveLength(2);
    expect(all.find((f) => f.id === fs1.id)?.isActive).toBe(false);
  });

  it("resolves the industry preset into a complete settlement policy", async () => {
    const sp = await createSettlementPolicy(TENANT, { industry: "travel" });
    expect(sp.industry).toBe("travel");
    expect(sp.availabilityMode).toBe("DELAY");
    expect(sp.availabilityDelayDays).toBe(7);
    expect(sp.reserveType).toBe("ROLLING");
    expect(sp.reservePercentageBps).toBe(1000);
    expect(sp.payoutSchedule).toBe("AUTO_WEEKLY");
  });

  it("applies explicit overrides on top of the preset", async () => {
    const sp = await createSettlementPolicy(TENANT, {
      industry: "travel",
      reservePercentageBps: 2500,
      availabilityDelayDays: 14,
    });
    expect(sp.reservePercentageBps).toBe(2500);
    expect(sp.availabilityDelayDays).toBe(14);
    expect(sp.availabilityMode).toBe("DELAY"); // preset default retained
    await expect(getActiveSettlementPolicy(TENANT)).resolves.toMatchObject({ id: sp.id });
    await expect(listSettlementPolicies(TENANT)).resolves.toHaveLength(1);
  });
});
