import fs from "fs";
import { buildOpenApiDocument } from "./openapi-document";

const json = JSON.stringify(buildOpenApiDocument(), null, 2);
fs.writeFileSync("openapi.json", json);
fs.writeFileSync("contract/openapi.json", json);
console.log("✅ Generated openapi.json + contract/openapi.json");
