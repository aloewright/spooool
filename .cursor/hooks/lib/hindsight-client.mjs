#!/usr/bin/env node
/** Thin Hindsight REST client for Cursor hooks. Mirrors fly-dev/worker/src/platform/memory/hindsight.ts */

import { execSync } from "node:child_process";

const TENANT = "default";
const DEFAULT_TIMEOUT_MS = 8_000;
const RECALL_TIMEOUT_MS = 4_000;

/** @typedef {{ baseUrl: string, apiKey?: string, cfAccessClientId?: string, cfAccessClientSecret?: string }} HindsightConfig */

/** @returns {HindsightConfig | null} */
export function loadConfigFromEnv() {
  const apiKey = process.env.HINDSIGHT_API_KEY;
  const baseUrl = process.env.HINDSIGHT_BASE_URL ?? "https://hindsight.fly.pm";
  const cfAccessClientId = process.env.HINDSIGHT_CF_ACCESS_CLIENT_ID;
  const cfAccessClientSecret = process.env.HINDSIGHT_CF_ACCESS_CLIENT_SECRET;
  if (apiKey) {
    return { baseUrl, apiKey, cfAccessClientId, cfAccessClientSecret };
  }
  if (!commandExists("doppler")) return null;
  try {
    const names = [
      "HINDSIGHT_API_KEY",
      "HINDSIGHT_BASE_URL",
      "HINDSIGHT_CF_ACCESS_CLIENT_ID",
      "HINDSIGHT_CF_ACCESS_CLIENT_SECRET",
    ];
    const out = execSync(
      `doppler secrets get ${names.join(" ")} --project quickapp --config dev --plain`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const [key, url, cfId, cfSecret] = out.trim().split("\n");
    if (!key) return null;
    return {
      baseUrl: url || baseUrl,
      apiKey: key,
      cfAccessClientId: cfId,
      cfAccessClientSecret: cfSecret,
    };
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} cwd */
export function bankKeyForWorkspace(cwd) {
  const name = cwd.split("/").filter(Boolean).pop() ?? "default";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `cursor-p-${slug || "default"}`;
}

/** @param {HindsightConfig} cfg */
export function createClient(cfg) {
  /** @param {string} bank @param {string} suffix */
  function bankPath(bank, suffix = "") {
    return `/v1/${TENANT}/banks/${encodeURIComponent(bank)}${suffix}`;
  }

  /** @param {Record<string, string>} extra */
  function headers(extra = {}) {
    const h = { "content-type": "application/json", ...extra };
    if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.cfAccessClientId) h["CF-Access-Client-Id"] = cfg.cfAccessClientId;
    if (cfg.cfAccessClientSecret) h["CF-Access-Client-Secret"] = cfg.cfAccessClientSecret;
    return h;
  }

  /** @param {string} path @param {string} method @param {unknown} body @param {number} timeoutMs */
  async function call(path, method, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      /** @type {RequestInit} */
      const init = { method, headers: headers(), signal: ctrl.signal };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(new URL(path, cfg.baseUrl).toString(), init);
      if (!res.ok) throw new Error(`hindsight ${method} ${path} -> HTTP ${res.status}`);
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async health() {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const res = await fetch(new URL("/health", cfg.baseUrl).toString(), {
          headers: headers(),
          signal: ctrl.signal,
        });
        return { ok: res.ok, detail: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(t);
      }
    },

    /** @param {string} bank */
    async ensureBank(bank) {
      try {
        await call(
          bankPath(bank),
          "PUT",
          {
            retain_mission:
              "Capture durable lessons from Cursor coding sessions on this project: what worked, what failed, user preferences, and workspace conventions.",
            reflect_mission:
              "Summarize what approaches succeed or fail on this project so future Cursor sessions avoid known pitfalls.",
            enable_observations: true,
          },
          DEFAULT_TIMEOUT_MS,
        );
        await call(
          bankPath(bank, "/mental-models"),
          "POST",
          {
            id: "project-playbook",
            name: "Project playbook",
            source_query:
              "What approaches succeed or fail on this project, and what should future Cursor sessions know?",
            trigger: { refresh_after_consolidation: true },
          },
          DEFAULT_TIMEOUT_MS,
        );
      } catch {
        /* best-effort */
      }
    },

    /** @param {{ bank: string, content: string, context?: Record<string, unknown>, tags?: string[], async?: boolean, timeoutMs?: number }} input */
    async retain(input) {
      const context = serializeContext(input.context ?? {});
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        const r = await call(
          bankPath(input.bank, "/memories"),
          "POST",
          {
            items: [
              {
                content: input.content,
                context,
                tags: input.tags ?? [],
                timestamp: new Date().toISOString(),
              },
            ],
            async: input.async ?? false,
          },
          timeoutMs,
        );
        return { ok: true, hindsightId: r.operation_id ?? null };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    /** @param {{ bank: string, items: Array<{ content: string, context?: Record<string, unknown>, tags?: string[] }>, async?: boolean, timeoutMs?: number }} input */
    async retainMany(input) {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        const r = await call(
          bankPath(input.bank, "/memories"),
          "POST",
          {
            items: input.items.map((item) => ({
              content: item.content,
              context: serializeContext(item.context ?? {}),
              tags: item.tags ?? [],
              timestamp: new Date().toISOString(),
            })),
            async: input.async ?? true,
          },
          timeoutMs,
        );
        return { ok: true, hindsightId: r.operation_id ?? null };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    /** @param {{ bank: string, query: string, limit?: number }} input */
    async recall(input) {
      try {
        const r = await call(
          bankPath(input.bank, "/memories/recall"),
          "POST",
          { query: input.query, budget: "mid", max_tokens: 2048 },
          RECALL_TIMEOUT_MS,
        );
        const memories = (r.results ?? [])
          .filter((x) => x.text)
          .slice(0, input.limit ?? 5)
          .map((x) => ({ id: x.id, text: x.text, type: x.type }));
        return { ok: true, memories };
      } catch (e) {
        return { ok: true, memories: [], error: e instanceof Error ? e.message : String(e) };
      }
    },

    /** @param {string} bank */
    async mentalModel(bank) {
      try {
        const r = await call(
          bankPath(bank, "/mental-models?detail=content"),
          "GET",
          undefined,
          RECALL_TIMEOUT_MS,
        );
        const list = Array.isArray(r.mental_models) ? r.mental_models : [];
        const m = list.find((x) => x.content?.trim());
        return m?.content ? { content: m.content, name: m.name } : null;
      } catch {
        return null;
      }
    },
  };
}

/** @param {Record<string, unknown>} ctx */
function serializeContext(ctx) {
  return Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join(" | ");
}

/** @param {{ memories: Array<{ text?: string }> }} recalled @param {{ content?: string, name?: string } | null} playbook */
export function formatRecallForPrompt(recalled, playbook) {
  const lines = [];
  if (playbook?.content?.trim()) {
    lines.push("## Project memory — playbook", playbook.content.trim());
  }
  const mems = recalled.memories.filter((m) => m.text?.trim()).slice(0, 5);
  if (mems.length) {
    lines.push("## Lessons from prior Cursor sessions on this project");
    for (const m of mems) lines.push(`- ${m.text.trim()}`);
  }
  if (!lines.length) return "";
  return `<project-memory source="hindsight">\n${lines.join("\n")}\n</project-memory>`;
}
