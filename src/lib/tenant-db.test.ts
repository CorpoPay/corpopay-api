import { describe, it, expect, vi } from "vitest";

vi.mock("./prisma", () => ({
  prisma: {
    // For the `forTenant` test we just want to capture/inspect the extension.
    $extends: vi.fn((ext: unknown) => ext),
  },
}));

import { prisma } from "./prisma";
import {
  forTenant,
  isTenantScopedModel,
  TENANT_SCOPED_MODELS,
  withTenantFilter,
} from "./tenant-db";

describe("isTenantScopedModel", () => {
  it("recognises tenant-owned models", () => {
    expect(isTenantScopedModel("PaymentLink")).toBe(true);
    expect(isTenantScopedModel("Subscription")).toBe(true);
  });

  it("excludes cross-tenant / non-tenant models", () => {
    expect(isTenantScopedModel("Tenant")).toBe(false);
    expect(isTenantScopedModel("ProviderHealth")).toBe(false);
    expect(isTenantScopedModel("WebhookEvent")).toBe(false);
    expect(isTenantScopedModel("AuditLog")).toBe(false);
    expect(isTenantScopedModel("ProviderTransaction")).toBe(false);
  });

  it("lists exactly the nine tenant-owned models", () => {
    expect(TENANT_SCOPED_MODELS).toEqual([
      "User",
      "ProviderConfig",
      "PaymentLink",
      "PaymentIntent",
      "Refund",
      "ApiKey",
      "Subscription",
      "InstallmentPlan",
      "InstallmentAgreement",
    ]);
  });
});

describe("withTenantFilter", () => {
  it("injects tenantId into a filter operation on a tenant model", () => {
    const args = withTenantFilter("t_1", "PaymentLink", "findMany", {
      where: { status: "ACTIVE" },
    });
    expect(args).toEqual({ where: { status: "ACTIVE", tenantId: "t_1" } });
  });

  it("adds a where clause when none is supplied", () => {
    const args = withTenantFilter("t_1", "PaymentIntent", "findMany", undefined);
    expect(args).toEqual({ where: { tenantId: "t_1" } });
  });

  it("preserves select/include/orderBy alongside the injected filter", () => {
    const args = withTenantFilter("t_1", "PaymentLink", "findMany", {
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    expect(args).toEqual({
      select: { id: true },
      orderBy: { createdAt: "desc" },
      where: { tenantId: "t_1" },
    });
  });

  it("scopes count / aggregate / groupBy / updateMany / deleteMany", () => {
    for (const op of [
      "findFirst",
      "findFirstOrThrow",
      "count",
      "aggregate",
      "groupBy",
      "updateMany",
      "deleteMany",
    ]) {
      const args = withTenantFilter("t_1", "Refund", op, { where: {} });
      expect((args as { where: Record<string, unknown> }).where).toEqual({ tenantId: "t_1" });
    }
  });

  it("does NOT touch unique-selector operations (findUnique/update/delete/upsert)", () => {
    for (const op of ["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]) {
      const args = withTenantFilter("t_1", "PaymentLink", op, { where: { id: "x" } });
      expect(args).toEqual({ where: { id: "x" } });
    }
  });

  it("does NOT touch non-tenant models", () => {
    const args = withTenantFilter("t_1", "ProviderHealth", "findMany", { where: {} });
    expect(args).toEqual({ where: {} });
  });

  it("does NOT touch create (no where)", () => {
    const args = withTenantFilter("t_1", "PaymentLink", "create", {
      data: { slug: "s" },
    });
    expect(args).toEqual({ data: { slug: "s" } });
  });
});

describe("forTenant", () => {
  it("delegates to prisma.$extends and scopes queries through withTenantFilter", async () => {
    const extend = prisma.$extends as ReturnType<typeof vi.fn>;
    const extension = forTenant("t_9") as unknown as {
      query: {
        $allModels: {
          $allOperations: (ctx: {
            model: string;
            operation: string;
            args: unknown;
            query: (a: unknown) => unknown;
          }) => unknown;
        };
      };
    };

    expect(extend).toHaveBeenCalledTimes(1);

    const query = vi.fn((a: unknown) => a);
    const result = await extension.query.$allModels.$allOperations({
      model: "PaymentLink",
      operation: "findMany",
      args: { where: { status: "ACTIVE" } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { status: "ACTIVE", tenantId: "t_9" },
    });
    expect(result).toEqual({ where: { status: "ACTIVE", tenantId: "t_9" } });
  });
});
