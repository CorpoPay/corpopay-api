/**
 * Cross-cutting middleware concerns (§3.10): security headers, CORS, and the
 * canonical 404 handler shape. These exercise the real Express app (with a
 * mocked Prisma client) rather than a route handler, so they prove the
 * app-wide glue is wired correctly.
 */
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});

import app from "../../src/app";

describe("security headers (Helmet)", () => {
  it("serves the expected security headers on every response", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // The Payzone relay page needs inline scripts + cross-origin form posts, so
    // the default CSP is relaxed for those two origins.
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("CORS", () => {
  it("allows the dashboard origin with credentials on a preflight", async () => {
    const res = await request(app)
      .options("/users")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

describe("404 handler", () => {
  it("returns the canonical { error, code } shape for unknown routes", async () => {
    const res = await request(app).get("/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });
});
