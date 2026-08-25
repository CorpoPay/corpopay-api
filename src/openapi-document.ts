import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./openapi";

/**
 * Build the OpenAPI 3.0 document from the zod-to-openapi registry.
 *
 * Shared by the CLI generator (`src/generate-openapi.ts`, which writes
 * `openapi.json` + `contract/openapi.json`) and the `/docs` endpoint
 * (`src/app.ts`, which renders it with Scalar).
 */
export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "CorpoPay API",
      version: "0.1.0",
      description: "Multi-tenant payment orchestration API.",
    },
    servers: [{ url: process.env.API_BASE_URL ?? "http://localhost:4000" }],
  });
}
