import { describe, expect, it } from "vitest";
import { buildLambdaEnvironment, ENV_VAR_NAMES, envSchema, OPTIONAL_ENV_VAR_NAMES } from "./env";

const REQUIRED_VARS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "JWT_SECRET",
  "JWT_EXPIRES_IN",
  "ENCRYPTION_KEY",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "API_BASE_URL",
  "WEB_BASE_URL",
] as const;

const OPTIONAL_VARS = [
  "NAPS_WEBHOOK_SECRET",
  "VPS_WEBHOOK_SECRET",
  "NOTIFICATION_SQS_QUEUE_URL",
] as const;

function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://user:pass@host/db",
    DIRECT_URL: "postgresql://user:pass@host/db",
    JWT_SECRET: "jwt-secret",
    JWT_EXPIRES_IN: "7d",
    ENCRYPTION_KEY: "a".repeat(64),
    INNGEST_EVENT_KEY: "event-key",
    INNGEST_SIGNING_KEY: "signing-key",
    API_BASE_URL: "https://api.example.com",
    WEB_BASE_URL: "https://app.example.com",
  };
}

describe("env spec (single source of truth)", () => {
  it("declares every required and optional var exactly once", () => {
    expect([...ENV_VAR_NAMES].sort()).toEqual([...REQUIRED_VARS, ...OPTIONAL_VARS].sort());
  });

  it("marks exactly the optional vars as optional", () => {
    expect([...OPTIONAL_ENV_VAR_NAMES].sort()).toEqual([...OPTIONAL_VARS].sort());
  });

  it("builds the Lambda environment with deployment constants only (secrets come from SSM)", () => {
    expect(buildLambdaEnvironment()).toEqual({ NODE_ENV: "production", API_PORT: "4000" });
  });

  it("rejects when a required var is missing", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const names = result.error.issues.map((i) => String(i.path[0]));
      expect(names).toContain("DATABASE_URL");
    }
  });

  it("rejects an invalid ENCRYPTION_KEY", () => {
    const result = envSchema.safeParse({
      ...validEnv(),
      ENCRYPTION_KEY: "not-a-hex-key!!",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a full valid env with optional vars absent", () => {
    expect(envSchema.safeParse(validEnv()).success).toBe(true);
  });
});
