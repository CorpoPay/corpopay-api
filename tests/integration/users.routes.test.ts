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

const mockFindMany = prisma.user.findMany as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.user.findFirst as ReturnType<typeof vi.fn>;
const mockCount = prisma.user.count as ReturnType<typeof vi.fn>;
const mockCreate = prisma.user.create as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null);
  mockCount.mockResolvedValue(2);
});

describe("users routes", () => {
  it("lists users for an OWNER", async () => {
    mockFindMany.mockResolvedValue([{ id: "u1", email: "a@x", role: "STAFF" }]);
    const res = await request(app).get("/users").set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects a STAFF user (OWNER-only route)", async () => {
    const res = await request(app).get("/users").set("Authorization", `Bearer ${STAFF_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("invites a user", async () => {
    mockCreate.mockResolvedValue({ id: "u2", email: "new@example.com", role: "STAFF" });
    const res = await request(app)
      .post("/users/invite")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ email: "new@example.com", role: "STAFF", password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("new@example.com");
  });

  it("returns 409 when the invite email already exists", async () => {
    mockFindFirst.mockResolvedValue({ id: "existing" });
    const res = await request(app)
      .post("/users/invite")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ email: "existing@example.com", role: "STAFF", password: "password123" });
    expect(res.status).toBe(409);
  });

  it("blocks demoting the only OWNER", async () => {
    mockCount.mockResolvedValue(1); // only one owner
    const res = await request(app)
      .patch("/users/user-owner/role")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ role: "STAFF" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LAST_OWNER");
  });

  it("blocks deleting your own account", async () => {
    const res = await request(app)
      .delete("/users/user-owner")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CANNOT_DELETE_SELF");
  });
});
