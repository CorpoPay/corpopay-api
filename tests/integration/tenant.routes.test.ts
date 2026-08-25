import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });
const ADMIN_TOKEN = mintToken({ id: "user-admin", tenantId: "tenant-a", role: "SUPER_ADMIN" });

const mockFindUniqueTenant = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;
const mockUpdateTenant = prisma.tenant.update as ReturnType<typeof vi.fn>;
const mockFindManyTenant = prisma.tenant.findMany as ReturnType<typeof vi.fn>;
const mockCountTenant = prisma.tenant.count as ReturnType<typeof vi.fn>;
const mockFindManyIntent = prisma.paymentIntent.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUniqueTenant.mockResolvedValue({
    id: "tenant-a",
    name: "Tenant A",
    slug: "tenant-a",
    status: "ACTIVE",
    environment: "SANDBOX",
    createdAt: new Date(),
    notifyWebhookUrl: null,
    notifyEmail: null,
  });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindManyTenant.mockResolvedValue([]);
  mockCountTenant.mockResolvedValue(0);
  mockFindManyIntent.mockResolvedValue([]);
});

describe("tenant routes", () => {
  it("returns the authenticated tenant's own profile", async () => {
    const res = await request(app).get("/tenant").set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("tenant-a");
  });

  it("updates the tenant profile", async () => {
    mockUpdateTenant.mockResolvedValue({
      id: "tenant-a",
      name: "New Name",
      slug: "tenant-a",
      notifyWebhookUrl: null,
      notifyEmail: null,
    });
    const res = await request(app)
      .patch("/tenant")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
  });

  it("lists tenants for an admin", async () => {
    mockFindManyTenant.mockResolvedValue([
      {
        id: "tenant-a",
        name: "Tenant A",
        slug: "tenant-a",
        status: "ACTIVE",
        environment: "SANDBOX",
        createdAt: new Date(),
        _count: { paymentIntents: 0 },
        providerConfigs: [],
      },
    ]);
    const res = await request(app)
      .get("/admin/tenants")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("rejects a non-admin listing tenants", async () => {
    const res = await request(app)
      .get("/admin/tenants")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it("transitions a tenant status as SUPER_ADMIN", async () => {
    mockUpdateTenant.mockResolvedValue({ id: "tenant-a", status: "DISABLED" });
    const res = await request(app)
      .patch("/admin/tenants/tenant-a/status")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "DISABLED" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("DISABLED");
  });
});
