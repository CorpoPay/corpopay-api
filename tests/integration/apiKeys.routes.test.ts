import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed"), compare: vi.fn() } }));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });
const STAFF_TOKEN = mintToken({ id: "user-staff", tenantId: "tenant-a", role: "STAFF" });

const mockFindMany = prisma.apiKey.findMany as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.apiKey.findFirst as ReturnType<typeof vi.fn>;
const mockCreate = prisma.apiKey.create as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.apiKey.update as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null);
});

describe("api keys routes", () => {
  it("lists active API keys for an OWNER", async () => {
    mockFindMany.mockResolvedValue([{ id: "k1", name: "Key", keyPrefix: "cp_live_xxxx" }]);
    const res = await request(app).get("/api-keys").set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects STAFF (OWNER-only)", async () => {
    const res = await request(app).get("/api-keys").set("Authorization", `Bearer ${STAFF_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it("creates a key and returns the raw key exactly once", async () => {
    mockCreate.mockResolvedValue({
      id: "k2",
      name: "My Key",
      keyPrefix: "cp_live_abcdefgh",
      createdAt: new Date(),
    });
    const res = await request(app)
      .post("/api-keys")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ name: "My Key" });
    expect(res.status).toBe(201);
    expect(res.body.rawKey).toMatch(/^cp_live_[0-9a-f]{64}$/);
    // The stored keyHash is bcrypt and keySha256 is SHA-256 — neither is the raw key.
    const createData = mockCreate.mock.calls[0][0].data;
    expect(createData.keySha256).not.toBe(res.body.rawKey);
  });

  it("revokes a key (soft delete)", async () => {
    mockFindFirst.mockResolvedValue({ id: "k1" });
    const res = await request(app)
      .delete("/api-keys/k1")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(204);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("returns 404 revoking a non-existent key", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await request(app)
      .delete("/api-keys/missing")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(404);
  });
});
