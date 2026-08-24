import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors tsconfig.json `paths` so `@/generated/prisma/client` resolves in tests.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/adapters/vps.adapter.ts",
        "src/routes/webhooks.ts",
        "src/jobs/webhookProcessor.inngest.ts",
        "src/lib/validateEnv.ts",
        "src/lib/encryption.ts",
      ],
      thresholds: {
        "src/adapters/vps.adapter.ts": { lines: 80 },
        "src/routes/webhooks.ts": { lines: 80 },
        "src/lib/validateEnv.ts": { lines: 100 },
        "src/lib/encryption.ts": { lines: 90 },
      },
      reporter: ["text", "lcov"],
    },
  },
});
