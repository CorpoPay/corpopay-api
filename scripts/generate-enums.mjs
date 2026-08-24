#!/usr/bin/env node
/**
 * Generate `contract/enums.ts` from `prisma/schema.prisma` — the single source
 * of truth for status/enum values. The web vendors this file (via `types:fetch`)
 * so it never hand-mirrors enum unions again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = readFileSync(resolve(repoRoot, "prisma/schema.prisma"), "utf8");

const enums = [];
const re = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;
let m;
while ((m = re.exec(schema))) {
  const name = m[1];
  const values = m[2]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
  enums.push({ name, values });
}

const lines = [
  "// Generated from prisma/schema.prisma — do not edit by hand.",
  "// Source of truth: corpopay-api/prisma/schema.prisma enums.",
  "// Regenerate with: npm run contract:generate",
  "",
];
for (const { name, values } of enums) {
  const quoted = values.map((v) => JSON.stringify(v));
  lines.push(`export type ${name} = ${quoted.join(" | ")};`);
  lines.push(`export const ${name}Values = [${quoted.join(", ")}] as const;`);
  lines.push("");
}

writeFileSync(resolve(repoRoot, "contract/enums.ts"), lines.join("\n"));
console.log(`Generated contract/enums.ts (${enums.length} enums)`);
