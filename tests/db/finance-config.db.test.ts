import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getEffectiveCapabilities,
  getEffectiveWalletCommissionBasis,
  requireCapability,
  upsertFinanceConfig,
} from "@/lib/finance-config-db";
import { prisma } from "@/lib/prisma";
import { makeTenant } from "../factories";

const TENANT = "finance-config-db";

describe("finance config (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.financeConfig.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.tenant.create({
      data: makeTenant({ id: TENANT, slug: TENANT, name: "Finance Config DB" }),
    });
  });

  afterAll(async () => {
    await prisma.financeConfig.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });

  beforeEach(async () => {
    await prisma.financeConfig.deleteMany({ where: { tenantId: TENANT } });
  });

  it("defaults to full capabilities (total flexibility) when no row exists", async () => {
    const caps = await getEffectiveCapabilities(TENANT);
    expect(caps).toEqual([
      "INSTANT_CAPTURE",
      "PREAUTH_CAPTURE",
      "WALLET",
      "SUBSCRIPTIONS",
      "INSTALLMENTS",
      "MARKETPLACE_SPLITS",
    ]);
  });

  it("persists and reads back a custom capability set", async () => {
    await upsertFinanceConfig(TENANT, {
      capabilities: ["WALLET", "INSTANT_CAPTURE"],
      preset: "wallet",
    });
    expect(await getEffectiveCapabilities(TENANT)).toEqual(["WALLET", "INSTANT_CAPTURE"]);
  });

  it("persists the wallet commission basis (defaults to usage)", async () => {
    await upsertFinanceConfig(TENANT, {
      capabilities: ["WALLET", "INSTANT_CAPTURE"],
      preset: "wallet",
    });
    expect(await getEffectiveWalletCommissionBasis(TENANT)).toBe("usage");

    await upsertFinanceConfig(TENANT, {
      capabilities: ["WALLET", "INSTANT_CAPTURE"],
      preset: "wallet",
      walletCommissionBasis: "load",
    });
    expect(await getEffectiveWalletCommissionBasis(TENANT)).toBe("load");
  });

  it("rejects a capability set missing its capture funding", async () => {
    await expect(
      upsertFinanceConfig(TENANT, { capabilities: ["SUBSCRIPTIONS"] }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_FINANCE_CONFIG",
    });
  });

  it("requireCapability throws 403 when disabled and passes when enabled", async () => {
    await upsertFinanceConfig(TENANT, { capabilities: ["INSTANT_CAPTURE"] });

    await expect(requireCapability(TENANT, "WALLET")).rejects.toMatchObject({
      statusCode: 403,
      code: "CAPABILITY_DISABLED",
    });
    await expect(requireCapability(TENANT, "INSTANT_CAPTURE")).resolves.toBeUndefined();
  });
});
