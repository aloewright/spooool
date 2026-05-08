// Trending list is cached in KV with a 5-minute TTL keyed by limit. Without a
// versioning step, an upload or delete is invisible from /trending until the
// TTL elapses. KV has no prefix/pattern delete, so the version key
// (trending:version) acts as a soft cache buster: write paths rotate it and
// read paths fold it into the cache key. Old entries become unreachable and
// expire on their own TTL.
//
// The version is a fresh unique string per bump rather than a counter:
// - Avoids the read-modify-write race where two concurrent bumps both observe
//   the same `current` and write the same `next`.
// - Avoids hammering KV's 1-write-per-second-per-key limit with monotonic
//   counter writes that contend on the same key for the same value.
// Bump failures are swallowed so a failed cache invalidation can't turn a
// successful upload/delete into a 5xx after DB/R2 mutations already landed;
// the TTL bounds the staleness window in the worst case.
//
// ALO-149: a cron-driven materializer (see `materializeTrending`) writes a
// pre-computed feed to a fixed KV key on a fixed cadence so the Home page
// never has to wait for a fresh D1 aggregation. Read paths prefer the
// materialized blob; the on-demand SQL path remains as a cold-start fallback
// for the first request after deploy or if the cron has not yet fired.

const TRENDING_VERSION_KEY = 'trending:version';

export const TRENDING_CACHE_TTL_SECONDS = 300;

// Fixed key for the cron-materialized trending feed. Independent from the
// versioned per-limit cache so bumps from upload/delete don't wipe it; the
// cron is the source of truth for this entry.
export const MATERIALIZED_TRENDING_KEY = 'trending:materialized';

// Cron cadence: 10 minutes. Tuned so a fresh upload becomes visible on Home
// within one cron tick at most. Lower would burn KV writes; higher hides new
// videos for too long. Keep wrangler.toml triggers in sync.
export const TRENDING_MATERIALIZE_INTERVAL_MINUTES = 10;

// Default size of the materialized feed. Must be >= the largest `limit` the
// /api/videos/trending endpoint accepts, so any in-range read can be served
// by slicing the materialized array.
export const TRENDING_MATERIALIZE_SIZE = 50;

// HN-style time decay. score = recent_views / (age_hours + 2)^GRAVITY.
// Higher GRAVITY punishes age more aggressively — 1.5 keeps a multi-day
// half-life so a low-traffic site still has fresh-looking trending.
const GRAVITY = 1.5;

export interface TrendingVideoRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  stream_video_id: string | null;
  thumbnail_url: string | null;
  view_count: number;
  created_at: string;
  channel_name: string | null;
  recent_views: number;
}

export interface ScoredTrendingVideo extends TrendingVideoRow {
  score: number;
}

export function trendingCacheKey(version: string, limit: number): string {
  return `trending:v${version}:limit=${limit}`;
}

export async function getTrendingCacheVersion(cache: KVNamespace): Promise<string> {
  return (await cache.get(TRENDING_VERSION_KEY)) ?? '1';
}

export async function bumpTrendingCacheVersion(cache: KVNamespace): Promise<string> {
  const next = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await cache.put(TRENDING_VERSION_KEY, next);
  } catch {
    // best-effort: TTL bounds staleness if KV rate-limits this write
  }
  return next;
}

// Aggregated views × recency. `recent_views` is the 7-day view count, and the
// denominator decays linearly with age in hours so a brand-new video with a
// handful of views can still beat an older one with a long tail.
export function computeTrendingScore(
  recentViews: number,
  createdAt: string,
  now: number = Date.now(),
): number {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 0;
  const ageHours = Math.max(0, (now - createdMs) / (1000 * 60 * 60));
  return (recentViews + 1) / Math.pow(ageHours + 2, GRAVITY);
}

export function rankTrending(
  rows: TrendingVideoRow[],
  limit: number,
  now: number = Date.now(),
): ScoredTrendingVideo[] {
  return rows
    .map((row) => ({ ...row, score: computeTrendingScore(row.recent_views, row.created_at, now) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.recent_views !== a.recent_views) return b.recent_views - a.recent_views;
      if (b.view_count !== a.view_count) return b.view_count - a.view_count;
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    })
    .slice(0, limit);
}

// SQL pulled out so the cron path and the on-demand fallback share one query.
// LIMIT is intentionally larger than the final feed: we want enough candidates
// to score in JS without picking up rows the time-decay would bury.
const CANDIDATE_QUERY = `SELECT v.id, v.user_id, v.title, v.description, v.stream_video_id, v.thumbnail_url,
            v.view_count, v.created_at, u.name AS channel_name,
            COUNT(views.id) AS recent_views
     FROM videos v
     LEFT JOIN user u ON u.id = v.user_id
     LEFT JOIN views ON views.video_id = v.id
       AND views.viewed_at >= datetime('now', '-7 days')
     WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL
     GROUP BY v.id
     ORDER BY recent_views DESC, v.view_count DESC, v.created_at DESC
     LIMIT ?`;

export async function fetchTrendingCandidates(
  db: D1Database,
  candidateLimit: number,
): Promise<TrendingVideoRow[]> {
  const { results } = await db
    .prepare(CANDIDATE_QUERY)
    .bind(candidateLimit)
    .all<TrendingVideoRow>();
  return results ?? [];
}

// Cron entrypoint. Rebuilds the materialized feed and writes it under a fixed
// KV key with a TTL of ~3× the cron interval so a missed tick still leaves a
// usable list rather than a hole.
export async function materializeTrending(env: {
  DB: D1Database;
  CACHE: KVNamespace;
}): Promise<{ count: number }> {
  const candidates = await fetchTrendingCandidates(env.DB, TRENDING_MATERIALIZE_SIZE);
  const ranked = rankTrending(candidates, TRENDING_MATERIALIZE_SIZE);
  await env.CACHE.put(MATERIALIZED_TRENDING_KEY, JSON.stringify(ranked), {
    expirationTtl: TRENDING_MATERIALIZE_INTERVAL_MINUTES * 60 * 3,
  });
  return { count: ranked.length };
}

export async function getMaterializedTrending(
  cache: KVNamespace,
): Promise<ScoredTrendingVideo[] | null> {
  return await cache.get<ScoredTrendingVideo[]>(MATERIALIZED_TRENDING_KEY, 'json');
}
