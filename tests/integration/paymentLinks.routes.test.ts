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

const mockFindConfig = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockCreateLink = prisma.paymentLink.create as ReturnType<typeof vi.fn>;
const mockFindMany = prisma.paymentLink.findMany as ReturnType<typeof vi.fn>;
const mockCount = prisma.paymentLink.count as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.paymentLink.findFirst as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.paymentLink.update as ReturnType<typeof vi.fn>;

const ACTIVE_LINK = {
  id: "link-1",
  tenantId: "tenant-a",
  slug: "link-1",
  amount: 250,
  currency: "MAD",
  description: "Test",
  reference: "REF-1",
  provider: "VPS",
  status: "ACTIVE",
  maxAttempts: 3,
  attemptCount: 1,
  expiresAt: null,
  isRecurring: false,
  billingInterval: null,
  intervalValue: 1,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindConfig.mockResolvedValue({ status: "CONNECTED" });
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockFindFirst.mockResolvedValue(ACTIVE_LINK);
});

describe("POST /payment-links", () => {
  it("creates a link and stores the amount as MAD (centimes → MAD)", async () => {
    mockCreateLink.mockResolvedValue(ACTIVE_LINK);
    const res = await request(app)
      .post("/payment-links")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        amount: 25000, // centimes
        currency: "MAD",
        description: "Test",
        reference: "REF-1",
        provider: "VPS",
      });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(250);
    // Money invariant: the DB row is written in MAD, never centimes.
    expect(mockCreateLink.mock.calls[0][0].data.amount).toBe(250);
  });

  it("rejects when the provider is not configured", async () => {
    mockFindConfig.mockResolvedValue(null);
    const res = await request(app)
      .post("/payment-links")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        amount: 1000,
        currency: "MAD",
        description: "Test",
        reference: "REF-1",
        provider: "VPS",
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("validates recurring links require a billingInterval", async () => {
    const res = await request(app)
      .post("/payment-links")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({
        amount: 1000,
        currency: "MAD",
        description: "Test",
        reference: "R",
        provider: "VPS",
        isRecurring: true,
      });
    expect(res.status).toBe(422);
  });
});

describe("GET /payment-links", () => {
  it("lists links with pagination metadata", async () => {
    mockFindMany.mockResolvedValue([ACTIVE_LINK]);
    const res = await request(app)
      .get("/payment-links")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("GET /payment-links/:id", () => {
  it("returns a single link", async () => {
    const res = await request(app)
      .get("/payment-links/link-1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("link-1");
  });

  it("returns 404 for a missing link", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await request(app)
      .get("/payment-links/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /payment-links/:id/cancel", () => {
  it("cancels an ACTIVE link", async () => {
    mockUpdate.mockResolvedValue({ id: "link-1", status: "CANCELED" });
    const res = await request(app)
      .patch("/payment-links/link-1/cancel")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELED");
  });

  it("rejects cancelling a non-ACTIVE link", async () => {
    mockFindFirst.mockResolvedValue({ ...ACTIVE_LINK, status: "PAID" });
    const res = await request(app)
      .patch("/payment-links/link-1/cancel")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /public/checkout/:slug", () => {
  const publicLink = {
    ...ACTIVE_LINK,
    tenant: { name: "Demo Merchant", status: "ACTIVE" },
  };

  it("returns the public checkout shape for an ACTIVE link", async () => {
    mockFindFirst.mockResolvedValue(publicLink);
    const res = await request(app).get("/public/checkout/link-1");
    expect(res.status).toBe(200);
    expect(res.body.merchantName).toBe("Demo Merchant");
    expect(res.body.amount).toBe(250);
    expect(res.body.reference).toBeUndefined(); // M-8: reference not exposed
  });

  it("returns 404 for an unknown slug", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await request(app).get("/public/checkout/unknown");
    expect(res.status).toBe(404);
  });

  it.each([
    ["CANCELED", "LINK_CANCELED"],
    ["PAID", "LINK_PAID"],
    ["EXPIRED", "LINK_EXPIRED"],
  ])("returns 410 for a %s link", async (status, code) => {
    mockFindFirst.mockResolvedValue({ ...publicLink, status });
    const res = await request(app).get("/public/checkout/link-1");
    expect(res.status).toBe(410);
    expect(res.body.code).toBe(code);
  });
});
