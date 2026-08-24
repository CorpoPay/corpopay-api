import rateLimit from "express-rate-limit";

/**
 * Rate limiters.
 *
 * H-5: Applied in all deployment modes (VPS/Docker + Lambda). On Lambda, API
 * Gateway throttling is the outer defence; these limits are the inner,
 * per-process defence (important during scale-down / cold starts).
 */

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 login/register attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", code: "RATE_LIMITED" },
  skip: () => process.env.NODE_ENV === "test",
});

export const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 checkout initiations per IP per minute (carding guard)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", code: "RATE_LIMITED" },
  skip: () => process.env.NODE_ENV === "test",
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 authenticated API requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", code: "RATE_LIMITED" },
  skip: () => process.env.NODE_ENV === "test",
});
