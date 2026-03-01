import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Append connection_limit=1 to the DATABASE_URL when running in Lambda.
 * Each Lambda instance is single-threaded — 1 connection per instance is enough.
 * Without this, Prisma defaults to (cpu_count * 2 + 1) connections, which
 * exhausts Neon's pgbouncer pool limit when many Lambda instances run concurrently.
 * See: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases/neon#configure-a-connection-url
 */
function getLambdaSafeDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return url;
  // Only apply in Lambda / production — dev keeps default multi-connection pool
  if (process.env.NODE_ENV !== 'production') return url;
  // Avoid double-appending
  if (url.includes('connection_limit=')) return url;
  return url.includes('?') ? `${url}&connection_limit=1` : `${url}?connection_limit=1`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
    datasources: {
      db: { url: getLambdaSafeDatabaseUrl() },
    },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
