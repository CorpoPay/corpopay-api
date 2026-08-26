/**
 * setup-db.ts — DB smoke-test environment.
 *
 * The Prisma client (src/lib/prisma.ts) reads DATABASE_URL at import time, so
 * this must run (via vitest `setupFiles`) before the test file imports it.
 * Defaults to the local docker-compose Postgres; CI overrides via env.
 */
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://corpopay:corpopay@localhost:5432/corpopay?schema=public";
}
