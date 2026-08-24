import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import fs from "fs";
import { registry } from "./openapi";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "CorpoPay API",
    version: "0.1.0",
    description: "Multi-tenant payment orchestration API.",
  },
  servers: [{ url: process.env.API_BASE_URL ?? "http://localhost:4000" }],
});

const json = JSON.stringify(document, null, 2);
fs.writeFileSync("openapi.json", json);
fs.writeFileSync("contract/openapi.json", json);
console.log("✅ Generated openapi.json + contract/openapi.json");
