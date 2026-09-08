/**
 * env.ts — single source of truth for environment variables.
 *
 * Every environment variable is declared exactly once here. The boot-time
 * validator (`validateEnv.ts`) derives from this module, so adding or renaming
 * a secret is a single edit.
 *
 * Rules:
 *   required      — must be present and non-empty (whitespace trimmed)
 *   required_hex  — must be present AND exactly `bytes * 2` hex characters
 *   optional      — may be absent; validated loosely, warned about at boot
 */
import { z } from "zod";

const hexKey = z
  .string()
  .regex(/^[0-9a-fA-F]+$/, "must be a hex string")
  .length(64, "must be 64 hex characters (32 bytes)");

export const envSchema = z.object({
  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().trim().min(1),
  DIRECT_URL: z.string().trim().min(1),

  // ── Auth ──────────────────────────────────────────────────────────────────
  JWT_SECRET: z.string().trim().min(1),
  JWT_EXPIRES_IN: z.string().trim().min(1),

  // ── Encryption ────────────────────────────────────────────────────────────
  ENCRYPTION_KEY: hexKey,

  // ── Inngest ───────────────────────────────────────────────────────────────
  INNGEST_EVENT_KEY: z.string().trim().min(1),
  INNGEST_SIGNING_KEY: z.string().trim().min(1),

  // ── URLs ──────────────────────────────────────────────────────────────────
  API_BASE_URL: z.string().trim().min(1),
  WEB_BASE_URL: z.string().trim().min(1),

  // ── Optional ──────────────────────────────────────────────────────────────
  NAPS_WEBHOOK_SECRET: z.string().optional(),
  VPS_WEBHOOK_SECRET: z.string().optional(),

  // ── FX (ADR 0006, phase 4) ────────────────────────────────────────────────
  // "sandbox" (default) | "ecb" — the free reference-rate source for FX quotes.
  FX_RATE_PROVIDER: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Human-readable descriptions, used in boot-time log messages only. */
export const ENV_DESCRIPTIONS: Record<keyof Env, string> = {
  DATABASE_URL: "Neon / Postgres connection string (pooled)",
  DIRECT_URL: "Neon / Postgres direct connection string (migrations)",
  JWT_SECRET: "HS256 signing secret for JWT access tokens",
  JWT_EXPIRES_IN: 'JWT expiry duration (e.g. "7d", "24h")',
  ENCRYPTION_KEY: "AES-256-GCM key — 64 hex characters (32 bytes)",
  INNGEST_EVENT_KEY: "Inngest event API key for inngest.send()",
  INNGEST_SIGNING_KEY: "Inngest signing key to verify inbound job invocations",
  API_BASE_URL: "Public base URL of this API (used to build callbackUrl)",
  WEB_BASE_URL: "Public base URL of the web frontend (used for checkoutUrl)",
  NAPS_WEBHOOK_SECRET: "HMAC secret for NAPS webhook signature verification",
  VPS_WEBHOOK_SECRET:
    "HMAC secret for VPS webhook signature verification (legacy — credentials stored per-tenant in DB)",
  FX_RATE_PROVIDER: 'FX reference-rate source: "sandbox" (default) or "ecb"',
};

/** Ordered list of every variable name, for boot-time validation and other consumers. */
export const ENV_VAR_NAMES = Object.keys(envSchema.shape) as (keyof Env)[];

/** Variable names that may be absent at runtime. */
export const OPTIONAL_ENV_VAR_NAMES = ENV_VAR_NAMES.filter((name) =>
  envSchema.shape[name].isOptional(),
);
