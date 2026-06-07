#!/usr/bin/env node
/** stop hook — retain high-signal session summary to Hindsight (fail-soft, no followup_message). */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { loadConfigFromEnv, createClient, bankKeyForWorkspace } from "./lib/hindsight-client.mjs";

const STATE_PATH = resolve(".cursor/hooks/state/hindsight-retain.json");
const DEFAULT_MIN_TURNS = 3;
const DEFAULT_MIN_MINUTES = 5;

/** @typedef {{ version: 1, lastRunAtMs: number, turnsSinceLastRun: number, lastTranscriptMtimeMs: number | null, lastProcessedGenerationId: string | null }} RetainState */

/** @typedef {{ conversation_id: string, generation_id?: string, status: string, loop_count: number, transcript_path?: string | null }} StopHookInput */

function loadState() {
  /** @type {RetainState} */
  const fallback = {
    version: 1,
    lastRunAtMs: 0,
    turnsSinceLastRun: 0,
    lastTranscriptMtimeMs: null,
    lastProcessedGenerationId: null,
  };
  if (!existsSync(STATE_PATH)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return fallback;
  }
}

/** @param {RetainState} state */
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** @param {string | null | undefined} transcriptPath */
function getTranscriptMtimeMs(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  return statSync(transcriptPath).mtimeMs;
}

/** @param {string} transcriptPath */
function summarizeTranscript(transcriptPath) {
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean);
  const recent = lines.slice(-40);

  /** @type {string[]} */
  const userQueries = [];
  /** @type {string[]} */
  const assistantTexts = [];

  for (const line of recent) {
    try {
      const row = JSON.parse(line);
      const role = row.role;
      const parts = row.message?.content;
      if (!Array.isArray(parts)) continue;

      for (const part of parts) {
        if (part.type !== "text" || !part.text) continue;
        const text = part.text.replace(/\[REDACTED\]/g, "").trim();
        if (!text || text.startsWith("<")) continue;

        if (role === "user") {
          const q = text.replace(/<user_query>\s*/g, "").replace(/<\/user_query>/g, "").trim();
          if (q && !q.startsWith("Run the `continual-learning`")) userQueries.push(q.slice(0, 500));
        } else if (role === "assistant" && text.length > 80) {
          assistantTexts.push(text.slice(0, 1200));
        }
      }
    } catch {
      /* skip malformed lines */
    }
  }

  const lastUser = userQueries.at(-1);
  const lastAssistant = assistantTexts.at(-1);
  if (!lastUser && !lastAssistant) return null;

  const parts = [];
  if (lastUser) parts.push(`User request: ${lastUser}`);
  if (lastAssistant) parts.push(`Outcome: ${lastAssistant}`);
  return parts.join("\n").slice(0, 3000);
}

async function main() {
  const disabled =
    process.env.HINDSIGHT_CURSOR_RETAIN === "0" ||
    process.env.HINDSIGHT_CURSOR_RETAIN === "false";
  if (disabled) {
    console.log(JSON.stringify({}));
    return 0;
  }

  /** @type {StopHookInput} */
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    console.log(JSON.stringify({}));
    return 0;
  }

  if (input.status !== "completed") {
    console.log(JSON.stringify({}));
    return 0;
  }

  const cfg = loadConfigFromEnv();
  if (!cfg) {
    console.error("[hindsight-retain] no config");
    console.log(JSON.stringify({}));
    return 0;
  }

  const state = loadState();
  const now = Date.now();
  const minTurns = Number(process.env.HINDSIGHT_RETAIN_MIN_TURNS ?? DEFAULT_MIN_TURNS);
  const minMinutes = Number(process.env.HINDSIGHT_RETAIN_MIN_MINUTES ?? DEFAULT_MIN_MINUTES);

  const countedTurn = input.loop_count === 0;
  const turnsSinceLastRun = countedTurn ? state.turnsSinceLastRun + 1 : state.turnsSinceLastRun;
  const minutesSinceLastRun =
    state.lastRunAtMs > 0 ? Math.floor((now - state.lastRunAtMs) / 60000) : Number.POSITIVE_INFINITY;
  const transcriptMtimeMs = getTranscriptMtimeMs(input.transcript_path);
  const hasTranscriptAdvanced =
    transcriptMtimeMs !== null &&
    (state.lastTranscriptMtimeMs === null || transcriptMtimeMs > state.lastTranscriptMtimeMs);
  const newGeneration =
    input.generation_id && input.generation_id !== state.lastProcessedGenerationId;

  const shouldRetain =
    countedTurn &&
    turnsSinceLastRun >= minTurns &&
    minutesSinceLastRun >= minMinutes &&
    hasTranscriptAdvanced &&
    newGeneration &&
    input.transcript_path;

  if (!shouldRetain) {
    state.turnsSinceLastRun = turnsSinceLastRun;
    saveState(state);
    console.log(JSON.stringify({}));
    return 0;
  }

  const summary = summarizeTranscript(input.transcript_path);
  if (!summary) {
    state.turnsSinceLastRun = turnsSinceLastRun;
    saveState(state);
    console.log(JSON.stringify({}));
    return 0;
  }

  const cwd = process.cwd();
  const bank = bankKeyForWorkspace(cwd);
  const client = createClient(cfg);
  await client.ensureBank(bank);

  const result = await client.retain({
    bank,
    content: summary,
    context: {
      tool: "cursor",
      repo: basename(cwd),
      conversation_id: input.conversation_id,
      generation_id: input.generation_id,
      status: input.status,
    },
    tags: ["cursor", basename(cwd)],
    async: true,
    timeoutMs: 10_000,
  });

  if (result.ok) {
    state.lastRunAtMs = now;
    state.turnsSinceLastRun = 0;
    state.lastTranscriptMtimeMs = transcriptMtimeMs;
    state.lastProcessedGenerationId = input.generation_id ?? null;
    saveState(state);
  } else {
    console.error("[hindsight-retain] retain failed:", result.error);
    state.turnsSinceLastRun = turnsSinceLastRun;
    saveState(state);
  }

  console.log(JSON.stringify({}));
  return 0;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

main().catch((err) => {
  console.error("[hindsight-retain] failed", err);
  console.log(JSON.stringify({}));
  process.exit(0);
});
