import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Direct (non-pooled) URL — the CLI uses this for `prisma migrate`.
    // Read from process.env (not `env()`) so `prisma generate` still works in
    // CI/local where DIRECT_URL is not injected (generate doesn't need a URL).
    url: process.env.DIRECT_URL,
  },
});
