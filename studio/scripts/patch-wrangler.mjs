#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , configPath, ...replacements] = process.argv;
if (!configPath) {
  console.error("usage: patch-wrangler.mjs <wrangler.jsonc> KEY=VALUE [KEY=VALUE...]");
  process.exit(1);
}

let content = readFileSync(resolve(configPath), "utf8");
for (const replacement of replacements) {
  const [key, value] = replacement.split("=");
  const placeholder = `PLACEHOLDER_${key}`;
  if (!content.includes(placeholder)) {
    console.warn(`patch-wrangler: ${placeholder} not found, skipping`);
    continue;
  }
  content = content.replaceAll(placeholder, value);
}
writeFileSync(resolve(configPath), content);
console.log(`patched ${configPath}`);
