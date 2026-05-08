// ALO-152: real related-video recommendations for the Watch page up-next list.
// Replaces the previous /trending fallback noted in Watch.tsx.
//
// Strategy (in order, deduped, capped at `limit`):
//   1. Same channel — most recent uploads from the source video's user_id.
//   2. Co-watch (ALO-123) — videos other viewers also watched. Joins
//      watch_history to itself on user_id; ranks by co-occurrence count.
//      Empty for videos no one's watched yet — that's fine, we fall through.
//   3. FTS5 over the source video's title — matches similar titles across
//      the catalog; reuses search.ts/buildFtsQuery so the syntax sanitisation
//      stays in one place.
//   4. Top-up — global most-viewed-then-newest, used when the first three
//      passes don't fill the slot.
//
// Hidden / soft-deleted / DMCA-disabled / non-ready rows are filtered at
// query time so a takedown disappears from related lists immediately.
//
// Cached per (id, limit) in KV with a short TTL. Uploads/deletes do NOT bust
// this cache directly — the 5-minute TTL bounds the staleness window, which
// is acceptable for a relevance feature and avoids a per-channel fanout.

import { Hono } from 'hono';
import { z } from 'zod';
import { buildFtsQuery } from './search';

export interface RelatedEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

interface RelatedVariables {
  user: { id: string } | null;
}

export const RELATED_CACHE_TTL_SECONDS = 300;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

const relatedQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export interface RelatedVideo {
  id: string;
  title: string;
  thumbnail_url: string | null;
  view_count: number;
  created_at: string;
  channel_name: string | null;
  channel_username: string | null;
}

export function relatedCacheKey(id: string, limit: number): string {
  return `related:v1:${id}:limit=${limit}`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export const relatedRoutes = new Hono<{
  Bindings: RelatedEnv;
  Variables: RelatedVariables;
}>();

relatedRoutes.get('/api/videos/:id/related', async (c) => {
  const id = c.req.param('id');
  const parsed = relatedQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  const cacheKey = relatedCacheKey(id, limit);
  const cached = await c.env.CACHE.get<{ videos: RelatedVideo[] }>(cacheKey, 'json');
  if (cached) {
    c.header('x-spooool-cache', 'hit');
    return c.json({ id, limit, videos: cached.videos, cached: true });
  }

  const source = await c.env.DB.prepare(
    `SELECT id, user_id, title FROM videos
     WHERE id = ? AND deleted_at IS NULL AND hidden_at IS NULL
       AND (dmca_status IS NULL OR dmca_status != 'disabled')`,
  )
    .bind(id)
    .first<{ id: string; user_id: string; title: string }>();
  if (!source) {
    return c.json({ error: 'Video not found' }, 404);
  }

  const seen = new Set<string>([id]);
  const out: RelatedVideo[] = [];

  const sameChannel = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.thumbnail_url, v.view_count, v.created_at,
            u.name AS channel_name, u.username AS channel_username
     FROM videos v
     LEFT JOIN user u ON u.id = v.user_id
     WHERE v.user_id = ? AND v.id != ?
       AND v.deleted_at IS NULL AND v.hidden_at IS NULL
       AND v.status = 'ready'
       AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
     ORDER BY v.created_at DESC
     LIMIT ?`,
  )
    .bind(source.user_id, id, limit)
    .all<RelatedVideo>();
  for (const v of sameChannel.results ?? []) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
    if (out.length >= limit) break;
  }

  if (out.length < limit) {
    const remaining = limit - out.length;
    const seenList = Array.from(seen);
    const cowatch = await c.env.DB.prepare(
      `SELECT v.id, v.title, v.thumbnail_url, v.view_count, v.created_at,
              u.name AS channel_name, u.username AS channel_username,
              COUNT(*) AS cowatch_count
       FROM watch_history wh1
       JOIN watch_history wh2 ON wh2.user_id = wh1.user_id AND wh2.video_id != wh1.video_id
       JOIN videos v ON v.id = wh2.video_id
       LEFT JOIN user u ON u.id = v.user_id
       WHERE wh1.video_id = ?
         AND v.deleted_at IS NULL AND v.hidden_at IS NULL
         AND v.status = 'ready'
         AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
         AND v.id NOT IN (${placeholders(seenList.length)})
       GROUP BY v.id
       ORDER BY cowatch_count DESC, v.view_count DESC, v.created_at DESC
       LIMIT ?`,
    )
      .bind(id, ...seenList, remaining)
      .all<RelatedVideo & { cowatch_count: number }>();
    for (const v of cowatch.results ?? []) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      const { cowatch_count: _ignored, ...rest } = v;
      out.push(rest);
      if (out.length >= limit) break;
    }
  }

  if (out.length < limit) {
    const ftsQuery = buildFtsQuery(source.title);
    if (ftsQuery) {
      const remaining = limit - out.length;
      const seenList = Array.from(seen);
      const ftsRows = await c.env.DB.prepare(
        `SELECT v.id, v.title, v.thumbnail_url, v.view_count, v.created_at,
                u.name AS channel_name, u.username AS channel_username
         FROM videos_fts
         JOIN videos v ON v.id = videos_fts.video_id
         LEFT JOIN user u ON u.id = v.user_id
         WHERE videos_fts MATCH ?
           AND v.deleted_at IS NULL AND v.hidden_at IS NULL
           AND v.status = 'ready'
           AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
           AND v.id NOT IN (${placeholders(seenList.length)})
         ORDER BY videos_fts.rank
         LIMIT ?`,
      )
        .bind(ftsQuery, ...seenList, remaining)
        .all<RelatedVideo>();
      for (const v of ftsRows.results ?? []) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        out.push(v);
        if (out.length >= limit) break;
      }
    }
  }

  if (out.length < limit) {
    const remaining = limit - out.length;
    const seenList = Array.from(seen);
    const fillRows = await c.env.DB.prepare(
      `SELECT v.id, v.title, v.thumbnail_url, v.view_count, v.created_at,
              u.name AS channel_name, u.username AS channel_username
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL
         AND v.status = 'ready'
         AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
         AND v.id NOT IN (${placeholders(seenList.length)})
       ORDER BY v.view_count DESC, v.created_at DESC
       LIMIT ?`,
    )
      .bind(...seenList, remaining)
      .all<RelatedVideo>();
    for (const v of fillRows.results ?? []) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
      if (out.length >= limit) break;
    }
  }

  // Best-effort write — a failed cache put can't fail the response.
  try {
    await c.env.CACHE.put(cacheKey, JSON.stringify({ videos: out }), {
      expirationTtl: RELATED_CACHE_TTL_SECONDS,
    });
  } catch {
    // KV write rate limits or transient errors fall through; TTL absorbs staleness.
  }

  c.header('x-spooool-cache', 'miss');
  return c.json({ id, limit, videos: out, cached: false });
});
