/**
 * E2E: RBAC matrix + tenant isolation.
 *
 * Exercises the role gates (`requireMerchant` / `requireOwner` / `requireAdmin`
 * / `requireSuperAdmin`) across representative routes with real tokens, and
 * asserts the tenant-scoping rule at the `forTenant` boundary (cross-tenant IDOR
 * regression guard).
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
vi.mock("../../src/config/inngest", () => ({
  inngestHandler: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../src/lib/inngest", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/lib/encryption", () => ({
  encryptCredentials: vi.fn(() => "v2:{}"),
  decryptCredentials: vi.fn(() => ({})),
}));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { withTenantFilter } from "../../src/lib/tenant-db";
import { mintToken } from "../factories";

const tokens = {
  superAdmin: mintToken({ id: "a", tenantId: "tenant-a", role: "SUPER_ADMIN" }),
  supportAdmin: mintToken({ id: "b", tenantId: "tenant-a", role: "SUPPORT_ADMIN" }),
  owner: mintToken({ id: "c", tenantId: "tenant-a", role: "OWNER" }),
  staff: mintToken({ id: "d", tenantId: "tenant-a", role: "STAFF" }),
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.paymentLink.findMany.mockResolvedValue([]);
  prisma.paymentLink.count.mockResolvedValue(0);
  prisma.providerHealth.findMany.mockResolvedValue([]);
  prisma.providerConfig.findMany.mockResolvedValue([]);
  prisma.auditLog.create.mockResolvedValue({});
  prisma.providerHealth.upsert.mockResolvedValue({});
});

describe("RBAC matrix", () => {
  const merchantRoute = "/payment-links"; // requireMerchant (OWNER | STAFF)
  const ownerRoute = "/provider-configs"; // requireOwner (OWNER only)
  const adminRoute = "/admin/provider-health"; // requireAdmin (SUPPORT_ADMIN | SUPER_ADMIN)

  it("merchant route: OWNER and STAFF allowed, admins + anonymous rejected", async () => {
    expect(
      (await request(app).get(merchantRoute).set("Authorization", `Bearer ${tokens.owner}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get(merchantRoute).set("Authorization", `Bearer ${tokens.staff}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get(merchantRoute).set("Authorization", `Bearer ${tokens.superAdmin}`))
        .status,
    ).toBe(403);
    expect((await request(app).get(merchantRoute)).status).toBe(401);
  });

  it("owner route: OWNER allowed, STAFF and admins rejected", async () => {
    expect(
      (await request(app).get(ownerRoute).set("Authorization", `Bearer ${tokens.owner}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get(ownerRoute).set("Authorization", `Bearer ${tokens.staff}`)).status,
    ).toBe(403);
    expect(
      (await request(app).get(ownerRoute).set("Authorization", `Bearer ${tokens.superAdmin}`))
        .status,
    ).toBe(403);
  });

  it("admin route: SUPER_ADMIN and SUPPORT_ADMIN allowed, OWNER rejected", async () => {
    expect(
      (await request(app).get(adminRoute).set("Authorization", `Bearer ${tokens.superAdmin}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get(adminRoute).set("Authorization", `Bearer ${tokens.supportAdmin}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get(adminRoute).set("Authorization", `Bearer ${tokens.owner}`)).status,
    ).toBe(403);
  });

  it("super-admin route: SUPER_ADMIN allowed, SUPPORT_ADMIN rejected", async () => {
    const put = () =>
      request(app)
        .put("/admin/provider-health/VPS")
        .set("Authorization", `Bearer ${tokens.superAdmin}`)
        .send({ status: "DEGRADED" });
    const putAsSupport = () =>
      request(app)
        .put("/admin/provider-health/VPS")
        .set("Authorization", `Bearer ${tokens.supportAdmin}`)
        .send({ status: "DEGRADED" });

    expect((await put()).status).toBe(200);
    expect((await putAsSupport()).status).toBe(403);
  });
});

describe("tenant isolation (cross-tenant IDOR guard)", () => {
  it("withTenantFilter injects the caller's tenantId into tenant-scoped queries", () => {
    // A token for tenant A must scope every tenant-owned query to tenant A —
    // even when the caller addresses a row that belongs to tenant B.
    expect(
      withTenantFilter("tenant-a", "PaymentLink", "findFirst", {
        where: { id: "link-owned-by-b" },
      }),
    ).toEqual({ where: { id: "link-owned-by-b", tenantId: "tenant-a" } });
  });

  it("withTenantFilter leaves cross-tenant models (WebhookEvent) unscoped", () => {
    expect(withTenantFilter("tenant-a", "WebhookEvent", "findMany", { where: {} })).toEqual({
      where: {},
    });
  });

  it("unique-selector operations are NOT auto-scoped (callers must use findFirst)", () => {
    expect(
      withTenantFilter("tenant-a", "PaymentLink", "findUnique", { where: { id: "x" } }),
    ).toEqual({
      where: { id: "x" },
    });
  });
});
