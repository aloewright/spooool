import { Hono } from 'hono';
import { z } from 'zod';
import {
  SEARCH_BUCKET,
  clientIp,
  rateLimit,
  rateLimitHeaders,
} from './rate-limit';

export interface SearchEnv {
  DB: D1Database;
  RATE_LIMITER?: DurableObjectNamespace;
}

interface SearchVariables {
  user: { id: string } | null;
}

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

// Convert a free-text query into a safe FTS5 MATCH expression.
// - Tokenizes on whitespace
// - Strips characters that have meaning in FTS5 syntax (`*`, `:`, `"`, `(`, `)`, `^`)
// - Wraps each token in double quotes (literal phrase) and adds `*` for prefix match
// - Drops tokens that became empty after stripping
// Returns null when no usable tokens remain.
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["*:()^]/g, ''))
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export const searchRoutes = new Hono<{ Bindings: SearchEnv; Variables: SearchVariables }>();

searchRoutes.get('/api/videos/search', async (c) => {
  // ALO-168: per-user when signed in (more permissive — same identity across
  // NATs); per-IP otherwise. Search is a low-cost read but a tight loop can
  // still hammer FTS5.
  const user = c.get('user');
  const identity = user ? `u:${user.id}` : `ip:${clientIp(c.req.raw)}`;
  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: SEARCH_BUCKET, identity });
  if (!rl.allowed) {
    return c.json({ error: 'Search rate limit exceeded.' }, 429, rateLimitHeaders(rl));
  }

  const parsed = searchQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const { q, page, limit } = parsed.data;
  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) {
    return c.json({ q, page, limit, total: 0, videos: [] });
  }

  const offset = (page - 1) * limit;
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.user_id, v.title, v.description, v.stream_video_id,
            v.thumbnail_url, v.view_count, v.created_at, v.updated_at,
            u.name AS channel_name, u.username AS channel_username,
            videos_fts.rank AS rank
     FROM videos_fts
     JOIN videos v ON v.id = videos_fts.video_id
     LEFT JOIN user u ON u.id = v.user_id
     WHERE videos_fts MATCH ?1 AND v.deleted_at IS NULL
     ORDER BY rank
     LIMIT ?2 OFFSET ?3`,
  )
    .bind(ftsQuery, limit, offset)
    .all();

  return c.json({ q, page, limit, videos: results });
});
