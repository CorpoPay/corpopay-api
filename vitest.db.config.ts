import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * DB smoke-test config — runs only the real-Postgres suite. Kept separate from
 * the default config (which excludes tests/db/**) so `npm test` stays fast and
 * mock-based, while `npm run test:db` exercises the real query engine.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/db/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup-env.ts", "tests/db/setup-db.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
