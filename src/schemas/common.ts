import { z } from "zod";

/**
 * Shared validation helpers used across request schemas.
 * Single source of truth for URL validation (was previously duplicated in
 * `routes/paymentIntents.ts` and `routes/tenant.ts` with slightly different
 * logic).
 */

// H-6: Reject URLs pointing at private/loopback/metadata ranges to prevent SSRF.
const PRIVATE_HOSTNAME =
  /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|::1|169\.254\.)/i;

function safeUrl(val: string): boolean {
  try {
    const { protocol, hostname } = new URL(val);
    if (protocol !== "https:") return false; // HTTPS only
    if (PRIVATE_HOSTNAME.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export const SafeUrl = z.string().url().refine(safeUrl, {
  message: "URL must be HTTPS and not a private/loopback address",
});
