import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("api-types.d.ts", "dist/api-types.d.ts");
console.log("contract: copied api-types.d.ts -> dist/");
