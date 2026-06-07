#!/usr/bin/env node
/** sessionStart hook — recall Hindsight memories and inject as additional_context. */

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  loadConfigFromEnv,
  createClient,
  bankKeyForWorkspace,
  formatRecallForPrompt,
} from "./lib/hindsight-client.mjs";

const DISABLE =
  process.env.HINDSIGHT_CURSOR_RECALL === "0" ||
  process.env.HINDSIGHT_CURSOR_RECALL === "false";

async function main() {
  if (DISABLE) {
    console.log(JSON.stringify({}));
    return 0;
  }

  const cfg = loadConfigFromEnv();
  if (!cfg) {
    console.error("[hindsight-recall] no config (set HINDSIGHT_* or install doppler)");
    console.log(JSON.stringify({}));
    return 0;
  }

  const cwd = process.cwd();
  const bank = bankKeyForWorkspace(cwd);
  const client = createClient(cfg);

  // Seed query from AGENTS.md title lines when present.
  let query = `Cursor session on ${basename(cwd)} — project conventions and recent lessons`;
  const agentsPath = resolve(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const agents = readFileSync(agentsPath, "utf8");
    const prefs = agents.match(/## Learned User Preferences[\s\S]*?(?=##|$)/)?.[0] ?? "";
    if (prefs.trim()) query = `Project preferences and workspace facts for ${basename(cwd)}`;
  }

  const [recalled, playbook] = await Promise.all([
    client.recall({ bank, query, limit: 5 }),
    client.mentalModel(bank),
  ]);

  const block = formatRecallForPrompt(recalled, playbook);
  if (!block) {
    console.log(JSON.stringify({}));
    return 0;
  }

  console.log(JSON.stringify({ additional_context: block }));
  return 0;
}

main().catch((err) => {
  console.error("[hindsight-recall] failed", err);
  console.log(JSON.stringify({}));
  process.exit(0);
});
