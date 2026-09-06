/**
 * validateEnv — boot-time environment variable guard.
 *
 * Called once at the very start of server.ts before any middleware, routes, or
 * DB connections are initialised. If a required variable is absent or malformed
 * the process throws synchronously so startup fails loudly rather than silently
 * serving 500s on the first real request.
 *
 * The rules live in `env.ts` (single source of truth); this module only
 * applies them to `process.env` and formats the result.
 */
import { ENV_DESCRIPTIONS, ENV_VAR_NAMES, envSchema, OPTIONAL_ENV_VAR_NAMES } from "./env";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

export function validateEnv(): void {
  // Optional vars never throw — they are warned about when absent/empty.
  const warnings: string[] = [];
  for (const name of OPTIONAL_ENV_VAR_NAMES) {
    const value = process.env[name];
    if (!value || value.trim() === "") {
      warnings.push(`  ⚠  ${name} — not set. ${ENV_DESCRIPTIONS[name]}`);
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `${YELLOW}[validateEnv] ${warnings.length} optional variable(s) not configured:\n${warnings.join("\n")}${RESET}`,
    );
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? "?");
      const description = ENV_DESCRIPTIONS[name as keyof typeof ENV_DESCRIPTIONS];
      return description
        ? `  ✖  ${name} — ${issue.message}. ${description}`
        : `  ✖  ${name} — ${issue.message}`;
    });

    // Throw synchronously — the process fails before any request is served.
    throw new Error(
      `${RED}[validateEnv] ${result.error.issues.length} required environment variable(s) are missing or invalid:\n${errors.join("\n")}\n\nFix these in your environment and restart.${RESET}`,
    );
  }

  const requiredCount = ENV_VAR_NAMES.length - OPTIONAL_ENV_VAR_NAMES.length;
  console.info(`[validateEnv] ✔  all ${requiredCount} required env vars present`);
}
