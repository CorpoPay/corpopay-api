import cors from "cors";

/**
 * CORS policy for the API.
 *
 * Allows the merchant dashboard (WEB_BASE_URL) and local dev (localhost:3000)
 * with credentials (the dashboard sends a JWT via Authorization header, so the
 * browser origin must be explicitly allow-listed).
 */
export const corsMiddleware = cors({
  origin: [process.env.WEB_BASE_URL ?? "http://localhost:3000", "http://localhost:3000"],
  credentials: true,
});
