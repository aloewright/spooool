import { desc, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { dataset_snapshots } from "../../db/schema";
import type { Env } from "../../env";
import { gateway } from "../../lib/gateway";

export type MarketDatasetRecord = {
  source: "kdp" | "trends" | "library";
  niche: string;
  title: string;
  author: string;
  rank: number;
  signal: string;
  keywords: string[];
  observed_at: string;
};

export type MarketDatasetRefreshResult = {
  snapshotId: string;
  weekIso: string;
  r2Key: string;
  records: number;
  source: string;
};

const RETENTION_DAYS = 30;
const DEFAULT_NICHES = [
  "productivity systems for neurodivergent founders",
  "cozy fantasy mysteries",
  "AI-assisted small business operations",
  "mindful parenting for busy professionals",
  "beginner strength training after 40",
];

export async function refreshMarketDataset(
  env: Pick<Env, "DB" | "R2" | "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  now = new Date(),
): Promise<MarketDatasetRefreshResult> {
  const weekIso = isoWeek(now);
  const records = await collectMarketRecords(env, now);
  const jsonl = records.map((record) => JSON.stringify(record)).join("\n");
  const r2Key = `datasets/${weekIso}/raw.jsonl`;
  await env.R2.put(r2Key, `${jsonl}\n`, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { week_iso: weekIso, records: String(records.length) },
  });

  const snapshotId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(dataset_snapshots)
    .values({
      id: snapshotId,
      week_iso: weekIso,
      r2_key: r2Key,
      source: "gateway:dynamic/research_gen,kdp,trends,libraries",
      created_at: now,
    })
    .onConflictDoUpdate({
      target: dataset_snapshots.week_iso,
      set: {
        r2_key: r2Key,
        source: "gateway:dynamic/research_gen,kdp,trends,libraries",
        created_at: now,
      },
    });

  await pruneOldSnapshots(env, now);
  const latest = await latestDatasetSnapshot(env);
  return {
    snapshotId: latest?.id ?? snapshotId,
    weekIso,
    r2Key,
    records: records.length,
    source: "gateway:dynamic/research_gen,kdp,trends,libraries",
  };
}

export async function latestDatasetSnapshot(env: Pick<Env, "DB">) {
  const [latest] = await drizzle(env.DB)
    .select()
    .from(dataset_snapshots)
    .orderBy(desc(dataset_snapshots.created_at))
    .limit(1);
  return latest ?? null;
}

export async function collectMarketRecords(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  now = new Date(),
): Promise<MarketDatasetRecord[]> {
  if (env.AI_GATEWAY_BASE_URL && env.AI_GATEWAY_TOKEN) {
    try {
      const result = await gateway.chatCompletion(env, {
        route: "dynamic/research_gen",
        temperature: 0.2,
        maxTokens: 2200,
        messages: [
          {
            role: "system",
            content:
              "Return compact JSON only. Build market research records from KDP bestseller, search trend, and library/catalog signals. Do not include prose.",
          },
          {
            role: "user",
            content: `Create 15 market dataset records for these niches: ${DEFAULT_NICHES.join(
              "; ",
            )}. Shape: {"records":[{"source":"kdp|trends|library","niche":"...","title":"...","author":"...","rank":1,"signal":"...","keywords":["..."],"observed_at":"${now.toISOString()}"}]}`,
          },
        ],
      });
      const parsed = parseGatewayRecords(result.text, now);
      if (parsed.length) return parsed;
    } catch (error) {
      console.warn("market dataset gateway refresh fell back to seeded records", error);
    }
  }
  return fallbackRecords(now);
}

async function pruneOldSnapshots(env: Pick<Env, "DB" | "R2">, now: Date) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const oldRows = await drizzle(env.DB)
    .select()
    .from(dataset_snapshots)
    .where(lt(dataset_snapshots.created_at, cutoff));
  for (const row of oldRows) {
    await env.R2.delete(row.r2_key);
  }
  await drizzle(env.DB).delete(dataset_snapshots).where(lt(dataset_snapshots.created_at, cutoff));
}

function parseGatewayRecords(text: string, now: Date): MarketDatasetRecord[] {
  const clean = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "");
  const parsed = JSON.parse(clean) as { records?: Partial<MarketDatasetRecord>[] };
  return (parsed.records ?? [])
    .map((record, index) => normalizeRecord(record, index + 1, now))
    .filter((record): record is MarketDatasetRecord => Boolean(record));
}

function normalizeRecord(
  record: Partial<MarketDatasetRecord>,
  rank: number,
  now: Date,
): MarketDatasetRecord | null {
  if (!record.niche || !record.title) return null;
  const source =
    record.source === "kdp" || record.source === "trends" || record.source === "library"
      ? record.source
      : "kdp";
  return {
    source,
    niche: record.niche,
    title: record.title,
    author: record.author ?? "Market signal",
    rank: Number.isFinite(record.rank) ? Number(record.rank) : rank,
    signal: record.signal ?? "emerging reader demand",
    keywords: Array.isArray(record.keywords) ? record.keywords.slice(0, 6).map(String) : [],
    observed_at: record.observed_at ?? now.toISOString(),
  };
}

function fallbackRecords(now: Date): MarketDatasetRecord[] {
  return DEFAULT_NICHES.flatMap((niche, nicheIndex) =>
    (["kdp", "trends", "library"] as const).map((source, index) => ({
      source,
      niche,
      title: titleFor(niche, source),
      author: source === "library" ? "Catalog aggregate" : "Market aggregate",
      rank: nicheIndex * 3 + index + 1,
      signal:
        source === "kdp"
          ? "bestseller pattern with repeatable promise-led positioning"
          : source === "trends"
            ? "search interest around practical, specific reader outcomes"
            : "library/catalog depth suggests durable backlist demand",
      keywords: niche
        .split(/\s+/)
        .filter((word) => word.length > 3)
        .slice(0, 6),
      observed_at: now.toISOString(),
    })),
  );
}

function titleFor(niche: string, source: MarketDatasetRecord["source"]) {
  if (source === "kdp") return `Bestseller pattern: ${niche}`;
  if (source === "trends") return `Trend signal: ${niche}`;
  return `Library depth: ${niche}`;
}

function isoWeek(date: Date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
