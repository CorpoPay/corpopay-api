import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const ADMIN_TOKEN = mintToken({ id: "user-admin", tenantId: "tenant-a", role: "SUPER_ADMIN" });
const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockFindIntent = prisma.paymentIntent.findFirst as ReturnType<typeof vi.fn>;
const mockFindWebhook = prisma.webhookEvent.findMany as ReturnType<typeof vi.fn>;
const mockCountWebhook = prisma.webhookEvent.count as ReturnType<typeof vi.fn>;
const mockFindHealth = prisma.providerHealth.findMany as ReturnType<typeof vi.fn>;
const mockUpsertHealth = prisma.providerHealth.upsert as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  mockFindIntent.mockResolvedValue(null);
  mockFindWebhook.mockResolvedValue([]);
  mockCountWebhook.mockResolvedValue(0);
  mockFindHealth.mockResolvedValue([]);
  mockUpsertHealth.mockResolvedValue({});
  prisma.providerTransaction.findFirst.mockResolvedValue(null);
});

describe("admin routes", () => {
  it("rejects a non-admin", async () => {
    const res = await request(app)
      .get("/admin/provider-health")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it("searches payments by query", async () => {
    mockFindIntent.mockResolvedValue({
      id: "intent-1",
      correlationId: "corr-1",
      status: "SUCCEEDED",
    });
    const res = await request(app)
      .get("/admin/payments/search?q=corr-1")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.intent.id).toBe("intent-1");
  });

  it("rejects a search query shorter than 2 characters", async () => {
    const res = await request(app)
      .get("/admin/payments/search?q=a")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("QUERY_TOO_SHORT");
  });

  it("returns found:false for an unknown payment", async () => {
    const res = await request(app)
      .get("/admin/payments/search?q=unknown")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it("lists webhook events", async () => {
    mockFindWebhook.mockResolvedValue([{ id: "wh-1", provider: "VPS" }]);
    const res = await request(app)
      .get("/admin/webhooks")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("lists provider health (always includes NAPS and VPS)", async () => {
    const res = await request(app)
      .get("/admin/provider-health")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.map((h: { provider: string }) => h.provider)).toEqual(
      expect.arrayContaining(["NAPS", "VPS"]),
    );
  });

  it("updates provider health (SUPER_ADMIN)", async () => {
    const res = await request(app)
      .put("/admin/provider-health/VPS")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "DEGRADED", notes: "latency" });
    expect(res.status).toBe(200);
    expect(mockUpsertHealth).toHaveBeenCalled();
  });
});
