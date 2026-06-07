#!/usr/bin/env node
/** One-shot: ensure bank + seed AGENTS.md bullets into Hindsight. Run: node .cursor/hooks/seed-hindsight.mjs */

import { existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { loadConfigFromEnv, createClient, bankKeyForWorkspace } from "./lib/hindsight-client.mjs";

async function main() {
  const cfg = loadConfigFromEnv();
  if (!cfg) {
    console.error("No Hindsight config. Set HINDSIGHT_* env vars or run via doppler.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const bank = bankKeyForWorkspace(cwd);
  const client = createClient(cfg);

  const health = await client.health();
  console.log(`health: ${health.ok ? "ok" : "fail"} ${health.detail ?? ""}`);
  if (!health.ok) process.exit(1);

  await client.ensureBank(bank);
  console.log(`bank: ${bank}`);

  const agentsPath = resolve(cwd, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    console.log("No AGENTS.md — skipping seed");
    return;
  }

  const agents = readFileSync(agentsPath, "utf8");
  const sections = [
    { heading: "## Learned User Preferences", tag: "user-preferences" },
    { heading: "## Learned Workspace Facts", tag: "workspace-facts" },
  ];

  /** @type {Array<{ content: string, context: Record<string, unknown>, tags: string[] }>} */
  const items = [];

  for (const { heading, tag } of sections) {
    const block = agents.match(new RegExp(`${heading}[\\s\\S]*?(?=##|$)`))?.[0] ?? "";
    const bullets = block
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter((l) => l && !l.startsWith("#"));

    for (const bullet of bullets) {
      items.push({
        content: bullet,
        context: { source: "AGENTS.md", section: heading, repo: basename(cwd), tool: "cursor-seed" },
        tags: ["cursor", "seed", tag, basename(cwd)],
      });
    }
  }

  if (!items.length) {
    console.log("No bullets in AGENTS.md");
    return;
  }

  console.log(`seeding ${items.length} bullets (async batch)…`);
  const r = await client.retainMany({ bank, items, async: true, timeoutMs: 15_000 });
  console.log(r.ok ? "batch enqueued" : `batch failed: ${r.error}`);

  // Give async worker a moment before recall check.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const recalled = await client.recall({
    bank,
    query: "project conventions and user preferences for spooool",
    limit: 5,
  });
  console.log(`recall check: ${recalled.memories.length} memories`);
  for (const m of recalled.memories.slice(0, 3)) {
    console.log(`  - ${m.text?.slice(0, 80)}…`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
