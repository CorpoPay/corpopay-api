/**
 * setup-env.ts — global test environment, loaded by vitest `setupFiles`.
 *
 * Sets the values the real Express app, auth middleware, and factory `mintToken`
 * read at runtime. No secrets here — these are test-only constants.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.JWT_EXPIRES_IN = "1h";
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.API_BASE_URL = "http://localhost:4000";
process.env.WEB_BASE_URL = "http://localhost:3000";
