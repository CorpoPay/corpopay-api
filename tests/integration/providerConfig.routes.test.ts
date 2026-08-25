import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", async () => {
  const { buildMockPrisma } = await import("../helpers/mock-prisma");
  return { prisma: buildMockPrisma() };
});
vi.mock("../../src/lib/encryption", () => ({
  encryptCredentials: vi.fn(() => "v2:{}"),
  decryptCredentials: vi.fn(() => ({})),
}));
vi.mock("../../src/adapters/registry", () => ({
  getAdapter: vi.fn(() => ({ testConnection: vi.fn(async () => ({ connected: true })) })),
}));

import app from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { mintToken } from "../factories";

const OWNER_TOKEN = mintToken({ id: "user-owner", tenantId: "tenant-a", role: "OWNER" });

const mockFindMany = prisma.providerConfig.findMany as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.providerConfig.findFirst as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.providerConfig.findUnique as ReturnType<typeof vi.fn>;
const mockUpsert = prisma.providerConfig.upsert as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.providerConfig.update as ReturnType<typeof vi.fn>;
const mockDelete = prisma.providerConfig.delete as ReturnType<typeof vi.fn>;

const VPS_CREDS = {
  merchantAccount: "Int_demo_Test",
  paywallSecretKey: "secret",
  paywallUrl: "https://payment-sandbox.payzone.ma/pwthree/launch",
  apiUrl: "https://payment-sandbox.payzone.ma",
  callerName: "$apicaller",
  callerPassword: "password",
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-a", status: "ACTIVE" });
  prisma.auditLog.create.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockFindFirst.mockResolvedValue(null);
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockResolvedValue({
    id: "cfg",
    provider: "VPS",
    status: "MISSING",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mockUpdate.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
});

describe("provider config routes", () => {
  it("lists configs with masked credentials for an OWNER", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "cfg",
        provider: "VPS",
        status: "CONNECTED",
        environment: "SANDBOX",
        encryptedCredentials: "v2:{}",
      },
    ]);
    const res = await request(app)
      .get("/provider-configs")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body[0].provider).toBe("VPS");
  });

  it("creates (upserts) a VPS config", async () => {
    const res = await request(app)
      .post("/provider-configs")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ provider: "VPS", environment: "SANDBOX", ...VPS_CREDS });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("VPS");
  });

  it("rejects invalid VPS credentials", async () => {
    const res = await request(app)
      .post("/provider-configs")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ provider: "VPS" });
    expect(res.status).toBe(422);
  });

  it("toggles a config status", async () => {
    mockFindFirst.mockResolvedValue({ id: "cfg", status: "CONNECTED" });
    const res = await request(app)
      .patch("/provider-configs/cfg/status")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("DISABLED");
  });

  it("tests a config connection", async () => {
    mockFindFirst.mockResolvedValue({
      id: "cfg",
      status: "MISSING",
      provider: "VPS",
      encryptedCredentials: "v2:{}",
    });
    const res = await request(app)
      .post("/provider-configs/cfg/test")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
  });

  it("deletes a config", async () => {
    mockFindFirst.mockResolvedValue({ id: "cfg" });
    const res = await request(app)
      .delete("/provider-configs/cfg")
      .set("Authorization", `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(204);
  });
});
