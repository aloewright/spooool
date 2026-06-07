// Cron-driven cache warmer (called from the existing "*/5 * * * *" trigger).
// Refreshes ONLY cheap YouTube sources (channel uploads = ~1 quota unit,
// playlist = ~1) for feeds viewed in the last 7 days. Search (100 units) is
// deliberately NOT warmed — it refreshes lazily on view to protect quota.

import { getYouTubeChannelItems, getYouTubePlaylistItems, type YouTubeEnv } from './youtube';

export interface FeedWarmEnv extends YouTubeEnv {
  DB: D1Database;
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export async function warmFeedCaches(env: FeedWarmEnv, fetcher: typeof fetch = fetch): Promise<number> {
  if (!env.YOUTUBE_API_KEY) return 0;
  const since = Date.now() - RECENT_MS;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT fs.kind, fs.ref
     FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
     WHERE f.last_viewed_at IS NOT NULL AND f.last_viewed_at > ?
       AND fs.kind IN ('youtube_channel','youtube_playlist')
       -- web_search is the most cost-sensitive kind (multi-provider fan-out) — not pre-warmed, matching youtube_search.`,
  )
    .bind(since)
    .all<{ kind: string; ref: string }>();

  let warmed = 0;
  for (const row of results ?? []) {
    try {
      if (row.kind === 'youtube_channel') await getYouTubeChannelItems(env, row.ref, fetcher, true);
      else await getYouTubePlaylistItems(env, row.ref, fetcher, true);
      warmed++;
    } catch {
      // best-effort; a failing source must not abort the sweep
    }
  }
  return warmed;
}
