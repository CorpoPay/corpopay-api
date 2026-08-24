/**
 * Auth request schemas — single source of truth.
 *
 * `routes/auth.ts` validates request bodies with these; `openapi.ts` imports
 * them to generate the API contract, so a request shape change is a single edit.
 * Kept dependency-light (zod only) so they can be used at runtime without pulling
 * the build-time `zod-to-openapi` tooling into the Lambda bundle.
 */
import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const registerSchema = z.object({
  businessName: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});
