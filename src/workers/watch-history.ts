// ALO-145: signed-in watch history. POST records a view (UPSERT, so re-watches
// just bump watched_at), GET returns the most recent N joined with video
// metadata, DELETE clears the entire history for the calling user. Hidden /
// DMCA-disabled / deleted videos are filtered out of GET so disappearing
// content doesn't surface in the home feed even if the row still exists.

import { Hono } from 'hono';
import { z } from 'zod';

export interface WatchHistoryEnv {
  DB: D1Database;
}

type SessionUser = { id: string } | null;
type WatchHistoryVariables = { user: SessionUser };

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

const recordSchema = z.object({
  videoId: z.string().min(1).max(128),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
});

export interface WatchHistoryRow {
  video_id: string;
  watched_at: string;
  title: string;
  thumbnail_url: string | null;
  view_count: number;
  channel_name: string | null;
  channel_username: string | null;
}

export const watchHistoryRoutes = new Hono<{
  Bindings: WatchHistoryEnv;
  Variables: WatchHistoryVariables;
}>();

// POST /api/users/me/history { videoId } — UPSERT current row to bump
// watched_at. Returns 204 on success; the body is intentionally empty so the
// frontend can fire-and-forget without parsing JSON.
watchHistoryRoutes.post('/api/users/me/history', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const { videoId } = parsed.data;

  // Reject up front if the video isn't viewable; otherwise we'd accumulate
  // history rows pointing at hidden/deleted content.
  const exists = await c.env.DB.prepare(
    `SELECT 1 FROM videos
     WHERE id = ? AND deleted_at IS NULL AND hidden_at IS NULL
       AND status = 'ready'
       AND (dmca_status IS NULL OR dmca_status != 'disabled')`,
  )
    .bind(videoId)
    .first();
  if (!exists) {
    return c.json({ error: 'Video not found' }, 404);
  }

  await c.env.DB.prepare(
    `INSERT INTO watch_history (user_id, video_id, watched_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, video_id) DO UPDATE SET watched_at = CURRENT_TIMESTAMP`,
  )
    .bind(user.id, videoId)
    .run();

  return new Response(null, { status: 204 });
});

// GET /api/users/me/history?limit=N — most recent N for this user, joined
// with current video metadata. Hidden / DMCA-disabled / deleted videos are
// filtered out at query time so a subsequent takedown immediately disappears
// from the user's feed.
watchHistoryRoutes.get('/api/users/me/history', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  const { results } = await c.env.DB.prepare(
    `SELECT h.video_id, h.watched_at,
            v.title, v.thumbnail_url, v.view_count,
            u.name AS channel_name, u.username AS channel_username
     FROM watch_history h
     JOIN videos v ON v.id = h.video_id
     LEFT JOIN user u ON u.id = v.user_id
     WHERE h.user_id = ?
       AND v.deleted_at IS NULL AND v.hidden_at IS NULL
       AND v.status = 'ready'
       AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
     ORDER BY h.watched_at DESC
     LIMIT ?`,
  )
    .bind(user.id, limit)
    .all<WatchHistoryRow>();

  return c.json({ items: results ?? [] });
});

// DELETE /api/users/me/history — wipe all history rows for this user.
// Returns 204 even if there was nothing to delete (idempotent).
watchHistoryRoutes.delete('/api/users/me/history', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  await c.env.DB.prepare('DELETE FROM watch_history WHERE user_id = ?')
    .bind(user.id)
    .run();
  return new Response(null, { status: 204 });
});
