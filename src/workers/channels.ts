import { Hono } from 'hono';
import { z } from 'zod';

export interface ChannelEnv {
  DB: D1Database;
}

const pageQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(24),
});

interface ChannelHeaderRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  subscriberCount: number;
  videoCount: number;
  totalViews: number;
}

export const channelRoutes = new Hono<{ Bindings: ChannelEnv }>();

channelRoutes.get('/api/channels/:username', async (c) => {
  const username = c.req.param('username');
  const header = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.username, u.displayName, u.bio, u.avatarUrl, u.bannerUrl,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.channel_user_id = u.id) AS subscriberCount,
            (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id AND v.deleted_at IS NULL) AS videoCount,
            (SELECT COALESCE(SUM(v.view_count), 0) FROM videos v WHERE v.user_id = u.id AND v.deleted_at IS NULL) AS totalViews
     FROM user u
     WHERE u.username = ?`,
  )
    .bind(username)
    .first<ChannelHeaderRow>();

  if (!header) return c.json({ error: 'Channel not found' }, 404);
  return c.json({
    id: header.id,
    username: header.username,
    displayName: header.displayName ?? header.name,
    bio: header.bio,
    avatarUrl: header.avatarUrl,
    bannerUrl: header.bannerUrl,
    subscriberCount: Number(header.subscriberCount ?? 0),
    videoCount: Number(header.videoCount ?? 0),
    totalViews: Number(header.totalViews ?? 0),
  });
});

channelRoutes.get('/api/channels/:username/videos', async (c) => {
  const username = c.req.param('username');
  const parsed = pageQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  const owner = await c.env.DB.prepare('SELECT id FROM user WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();
  if (!owner) return c.json({ error: 'Channel not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, stream_video_id, status, view_count,
            thumbnail_url, created_at
     FROM videos
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(owner.id, limit, offset)
    .all();

  return c.json({ page, limit, videos: results });
});
