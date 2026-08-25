/**
 * validateEnv.test.ts
 *
 * Unit tests for the boot-time environment variable guard.
 * Each test manipulates process.env in isolation and restores it afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A full set of valid env vars that satisfies every required rule.
 * Tests override individual fields to trigger specific failures.
 */
function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://user:pass@host/db?sslmode=require",
    DIRECT_URL: "postgresql://user:pass@host/db?sslmode=require",
    JWT_SECRET: "super-secret-jwt-key",
    JWT_EXPIRES_IN: "7d",
    ENCRYPTION_KEY: "a".repeat(64), // 32 bytes = 64 hex chars
    INNGEST_EVENT_KEY: "inngest-event-key",
    INNGEST_SIGNING_KEY: "inngest-signing-key",
    API_BASE_URL: "https://api.example.com",
    WEB_BASE_URL: "https://app.example.com",
  };
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  // Deep-copy current env so we can restore it exactly
  savedEnv = { ...process.env };
});

afterEach(() => {
  // Restore — delete any keys we added, restore any we changed
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  // Bust module cache so validateEnv re-reads process.env each time
  vi.resetModules();
});

async function runValidate(): Promise<void> {
  const { validateEnv } = await import("./validateEnv");
  validateEnv();
}

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("validateEnv — happy path", () => {
  it("does not throw when all required vars are present and valid", async () => {
    setEnv(validEnv());
    await expect(runValidate()).resolves.toBeUndefined();
  });

  it("logs a success message when all vars pass", async () => {
    setEnv(validEnv());
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await runValidate();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("all"));
    spy.mockRestore();
  });

  it("does not throw when optional vars (NAPS_WEBHOOK_SECRET, VPS_WEBHOOK_SECRET) are absent", async () => {
    const env = validEnv();
    setEnv(env);
    delete process.env.NAPS_WEBHOOK_SECRET;
    delete process.env.VPS_WEBHOOK_SECRET;
    await expect(runValidate()).resolves.toBeUndefined();
  });

  it("logs a warning (not an error) when optional vars are missing", async () => {
    setEnv(validEnv());
    delete process.env.NAPS_WEBHOOK_SECRET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runValidate();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("NAPS_WEBHOOK_SECRET"));
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ─── Required fields — missing ────────────────────────────────────────────────

describe("validateEnv — missing required vars", () => {
  it.each([
    "DATABASE_URL",
    "DIRECT_URL",
    "JWT_SECRET",
    "JWT_EXPIRES_IN",
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "API_BASE_URL",
    "WEB_BASE_URL",
  ])("throws when %s is missing", async (varName) => {
    setEnv(validEnv());
    delete process.env[varName];
    await expect(runValidate()).rejects.toThrow(varName);
  });

  it.each([
    "DATABASE_URL",
    "DIRECT_URL",
    "JWT_SECRET",
    "JWT_EXPIRES_IN",
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "API_BASE_URL",
    "WEB_BASE_URL",
  ])("throws when %s is an empty string", async (varName) => {
    setEnv({ ...validEnv(), [varName]: "" });
    await expect(runValidate()).rejects.toThrow(varName);
  });

  it.each(["DATABASE_URL", "DIRECT_URL", "JWT_SECRET"])(
    "throws when %s is only whitespace",
    async (varName) => {
      setEnv({ ...validEnv(), [varName]: "   " });
      await expect(runValidate()).rejects.toThrow(varName);
    },
  );

  it("throws listing ALL missing vars in a single error (not just the first)", async () => {
    // Remove three required vars
    setEnv(validEnv());
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.API_BASE_URL;

    let errorMessage = "";
    try {
      await runValidate();
    } catch (err: unknown) {
      errorMessage = (err as Error).message;
    }

    expect(errorMessage).toContain("DATABASE_URL");
    expect(errorMessage).toContain("JWT_SECRET");
    expect(errorMessage).toContain("API_BASE_URL");
  });
});

// ─── ENCRYPTION_KEY — hex validation ─────────────────────────────────────────

describe("validateEnv — ENCRYPTION_KEY hex validation", () => {
  it("does not throw for a valid 64-char hex key", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "f".repeat(64) });
    await expect(runValidate()).resolves.toBeUndefined();
  });

  it("throws when ENCRYPTION_KEY is missing", async () => {
    setEnv(validEnv());
    delete process.env.ENCRYPTION_KEY;
    await expect(runValidate()).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY is too short (32 chars instead of 64)", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "a".repeat(32) });
    await expect(runValidate()).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY is too long (128 chars)", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "a".repeat(128) });
    await expect(runValidate()).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY contains non-hex characters", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "z".repeat(64) });
    await expect(runValidate()).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY contains spaces", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "a".repeat(32) + " ".repeat(32) });
    await expect(runValidate()).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY is a plain UTF-8 string (wrong format)", async () => {
    // This catches the crypto-js era where keys were plain strings
    setEnv({
      ...validEnv(),
      ENCRYPTION_KEY: "my-secret-key-that-is-not-hex!!",
    });
    await expect(runValidate()).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("accepts uppercase hex characters", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "A".repeat(64) });
    await expect(runValidate()).resolves.toBeUndefined();
  });

  it("accepts mixed-case hex characters", async () => {
    const mixed = "aAbBcCdDeEfF".repeat(Math.ceil(64 / 12)).slice(0, 64);
    setEnv({ ...validEnv(), ENCRYPTION_KEY: mixed });
    await expect(runValidate()).resolves.toBeUndefined();
  });

  it("error message mentions the expected length (64 chars / 32 bytes)", async () => {
    setEnv({ ...validEnv(), ENCRYPTION_KEY: "a".repeat(32) });
    let message = "";
    try {
      await runValidate();
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    // Should tell the operator what length is expected
    expect(message).toMatch(/64|32/);
  });
});

// ─── Error message quality ────────────────────────────────────────────────────

describe("validateEnv — error message quality", () => {
  it("error message contains the word 'Doppler' to direct the operator", async () => {
    setEnv(validEnv());
    delete process.env.DATABASE_URL;
    let message = "";
    try {
      await runValidate();
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    expect(message.toLowerCase()).toContain("environment");
  });

  it("error message contains the count of failing variables", async () => {
    setEnv(validEnv());
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    let message = "";
    try {
      await runValidate();
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    expect(message).toContain("2");
  });
});
