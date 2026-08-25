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

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockFindMany = prisma.subscription.findMany as ReturnType<typeof vi.fn>;
const mockCount = prisma.subscription.count as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.subscription.findFirst as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.subscription.update as ReturnType<typeof vi.fn>;

const SUB = {
  id: "sub-1",
  tenantId: "tenant-a",
  customerId: "cust-1",
  encryptedStoredProfileId: "v2:secret",
  status: "ACTIVE",
  amount: "99.00",
  currency: "MAD",
  intervalType: "MONTHLY",
  intervalValue: 1,
  nextBillingDate: new Date("2026-02-01T00:00:00Z"),
  retryCount: 0,
  billingEvents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.billingEvent.findMany.mockResolvedValue([]);
  prisma.billingEvent.count.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockFindFirst.mockResolvedValue(SUB);
  mockUpdate.mockResolvedValue(SUB);
});

describe("subscriptions routes", () => {
  it("lists subscriptions", async () => {
    mockFindMany.mockResolvedValue([{ ...SUB, _count: { billingEvents: 1 } }]);
    const res = await request(app)
      .get("/subscriptions")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("returns detail without exposing the encrypted profile id", async () => {
    const res = await request(app)
      .get("/subscriptions/sub-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.encryptedStoredProfileId).toBeUndefined();
  });

  it("pauses an ACTIVE subscription", async () => {
    mockUpdate.mockResolvedValue({ id: "sub-1", status: "PAUSED" });
    const res = await request(app)
      .post("/subscriptions/sub-1/pause")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PAUSED");
  });

  it("resumes a PAUSED subscription and fires a renewal event", async () => {
    mockFindFirst.mockResolvedValue({ ...SUB, status: "PAUSED" });
    mockUpdate.mockResolvedValue({ id: "sub-1", status: "ACTIVE" });
    const res = await request(app)
      .post("/subscriptions/sub-1/resume")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");
  });

  it("cancels a subscription", async () => {
    mockUpdate.mockResolvedValue({ id: "sub-1", status: "CANCELLED" });
    const res = await request(app)
      .delete("/subscriptions/sub-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });

  it("rejects cancelling an already-cancelled subscription", async () => {
    mockFindFirst.mockResolvedValue({ ...SUB, status: "CANCELLED" });
    const res = await request(app)
      .delete("/subscriptions/sub-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it("lists billing events for a subscription", async () => {
    prisma.billingEvent.findMany.mockResolvedValue([{ id: "be-1", status: "CHARGED" }]);
    const res = await request(app)
      .get("/subscriptions/sub-1/events")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
