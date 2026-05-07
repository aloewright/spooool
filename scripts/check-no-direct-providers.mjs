#!/usr/bin/env node
// ALO-191: guard rail that scans the runtime source tree for direct LLM /
// embedding / image / audio / STT / video provider calls. Every model call
// in spooool must route through the Cloudflare AI Gateway dynamic routes
// (`dynamic/text_gen`, `dynamic/ai_embed`, etc.). Direct provider SDKs or
// hardcoded provider URLs / model ids bypass caching, rate limits, BYOK,
// observability, and cost routing.
//
// What we forbid (in src/, scripts/, and tests/, excluding *.test.* mocks):
//
//   - imports of openai, @anthropic-ai/sdk, @ai-sdk/*, replicate, fal-ai, etc.
//   - hardcoded https://api.openai.com or https://api.anthropic.com URLs
//   - model ids that pin a specific provider (openai/gpt-…, anthropic/claude-…)
//
// What we allow:
//
//   - the AI Gateway compat endpoint (gateway.ai.cloudflare.com)
//   - dynamic/* route slugs
//   - env.AI bindings (Workers AI)
//   - this script itself (it has to talk about the patterns to forbid them)
//
// Usage: `node scripts/check-no-direct-providers.mjs`
//
// Exit 0 = clean, exit 1 = findings (CI fails).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const SCAN_DIRS = ['src', 'scripts', 'tests'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
// Tests legitimately import providers via mocks; skip them. The provider
// guard itself sits in scripts/ and references the patterns it forbids.
const SELF_PATH = relative(repoRoot, fileURLToPath(import.meta.url));
function isExcluded(rel) {
  if (rel === SELF_PATH) return true;
  if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) return true;
  if (rel.endsWith('.test.js') || rel.endsWith('.test.mjs')) return true;
  if (rel.endsWith('.test.cjs')) return true;
  return false;
}

const FORBIDDEN_IMPORTS = [
  /from\s+['"]openai['"]/,
  /from\s+['"]@anthropic-ai\/sdk['"]/,
  /from\s+['"]@ai-sdk\/[^'"]+['"]/,
  /from\s+['"]replicate['"]/,
  /from\s+['"]@fal-ai\/[^'"]*['"]/,
  /from\s+['"]cohere-ai['"]/,
  /from\s+['"]groq-sdk['"]/,
  /from\s+['"]@google\/generative-ai['"]/,
  /require\(\s*['"]openai['"]\s*\)/,
  /require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/,
];

const FORBIDDEN_URLS = [
  /https?:\/\/api\.openai\.com/,
  /https?:\/\/api\.anthropic\.com/,
  /https?:\/\/api\.replicate\.com/,
  /https?:\/\/[^/]*generativelanguage\.googleapis\.com/,
  /https?:\/\/api\.cohere\.com/,
  /https?:\/\/api\.groq\.com/,
];

const FORBIDDEN_MODEL_IDS = [
  /['"]openai\/gpt-[^'"]+['"]/,
  /['"]anthropic\/claude-[^'"]+['"]/,
  /['"]google\/gemini-[^'"]+['"]/,
];

const RULES = [
  ...FORBIDDEN_IMPORTS.map((pattern) => ({ kind: 'import', pattern })),
  ...FORBIDDEN_URLS.map((pattern) => ({ kind: 'url', pattern })),
  ...FORBIDDEN_MODEL_IDS.map((pattern) => ({ kind: 'model-id', pattern })),
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      yield* walk(abs);
    } else if (st.isFile() && SCAN_EXTS.has(extname(entry))) {
      yield abs;
    }
  }
}

const findings = [];
for (const dir of SCAN_DIRS) {
  const abs = join(repoRoot, dir);
  let exists = true;
  try {
    statSync(abs);
  } catch {
    exists = false;
  }
  if (!exists) continue;
  for (const file of walk(abs)) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    if (isExcluded(rel)) continue;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ file: rel, line: i + 1, kind: rule.kind, text: line.trim() });
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error('Direct provider calls detected. Route through AI Gateway dynamic routes.');
  console.error('See docs/ai-gateway.md for the policy.');
  console.error('');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.text}`);
  }
  console.error('');
  console.error(`${findings.length} finding(s).`);
  process.exit(1);
}

console.log('AI Gateway guard: 0 findings — all model calls route through dynamic/* routes.');
