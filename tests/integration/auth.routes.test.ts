/**
 * Integration tests for the auth router (register / login / me).
 * Exercises the real Express app + middleware + Zod validation with a mocked
 * Prisma client — no DB required.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn(async () => "hashed-password"),
    compare: vi.fn(async () => true),
  },
}));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { makeTenant, makeUser, mintToken } from "../factories";

const mockFindUser = prisma.user.findFirst as ReturnType<typeof vi.fn>;
const mockFindUniqueUser = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const mockCreateUser = prisma.user.create as ReturnType<typeof vi.fn>;
const mockCreateTenant = prisma.tenant.create as ReturnType<typeof vi.fn>;
const mockFindUniqueTenant = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;

const OWNER = makeUser({ id: "user-owner", email: "owner@tenant-a.local" });
const TENANT = makeTenant({ id: "tenant-a", slug: "tenant-a", status: "ACTIVE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue(null);
  // Tenant is ACTIVE for auth checks (login + requireAuth tenant-status check).
  mockFindUniqueTenant.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
});

describe("POST /auth/register", () => {
  it("creates a tenant + owner and returns a token", async () => {
    mockCreateTenant.mockResolvedValue(TENANT);
    mockCreateUser.mockResolvedValue(OWNER);

    const res = await request(app).post("/auth/register").send({
      businessName: "Demo Merchant",
      email: "owner@tenant-a.local",
      password: "password123",
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("token");
    expect(res.body.tenant.slug).toBe("tenant-a"); // echoes the stubbed tenant
    expect(res.body.user.email).toBe("owner@tenant-a.local");

    // The route slugifies the business name and passes it to the tenant create.
    expect(mockCreateTenant).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Demo Merchant",
        slug: expect.stringContaining("demo-merchant"),
      }),
    });
  });

  it("returns 409 when the email is already taken", async () => {
    mockFindUser.mockResolvedValue(OWNER);
    const res = await request(app).post("/auth/register").send({
      businessName: "Demo Merchant",
      email: "owner@tenant-a.local",
      password: "password123",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_TAKEN");
  });

  it("returns 422 for an invalid body", async () => {
    const res = await request(app).post("/auth/register").send({ email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /auth/login", () => {
  it("returns a token for valid credentials", async () => {
    mockFindUser.mockResolvedValue(OWNER);

    const res = await request(app).post("/auth/login").send({
      email: "owner@tenant-a.local",
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.user.role).toBe("OWNER");
  });

  it("returns 401 for an unknown email", async () => {
    mockFindUser.mockResolvedValue(null);
    const res = await request(app).post("/auth/login").send({
      email: "nobody@tenant-a.local",
      password: "password123",
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 403 when the tenant is disabled", async () => {
    mockFindUser.mockResolvedValue(OWNER);
    mockFindUniqueTenant.mockResolvedValue({ id: "tenant-a", status: "DISABLED" });

    const res = await request(app).post("/auth/login").send({
      email: "owner@tenant-a.local",
      password: "password123",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TENANT_DISABLED");
  });
});

describe("GET /auth/me", () => {
  it("returns the authenticated user's profile", async () => {
    mockFindUniqueUser.mockResolvedValue({
      id: "user-owner",
      email: "owner@tenant-a.local",
      role: "OWNER",
      createdAt: new Date(),
      tenant: {
        id: "tenant-a",
        name: "Tenant A",
        slug: "tenant-a",
        environment: "SANDBOX",
        status: "ACTIVE",
      },
    });

    const res = await request(app)
      .get("/auth/me")
      .set(
        "Authorization",
        `Bearer ${mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" })}`,
      );

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("owner@tenant-a.local");
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});
