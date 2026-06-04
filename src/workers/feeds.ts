import { Hono } from 'hono';
import { z } from 'zod';
import {
  assembleFeed,
  parseSqliteTimestamp,
  type FeedItem,
  type FeedSourceKind,
  type SourceResult,
} from './feed-item';
import {
  getYouTubeChannelItems,
  getYouTubePlaylistItems,
  getYouTubeSearchItems,
  parseChannelInput,
  parsePlaylistInput,
  resolveYouTubeChannel,
  resolveYouTubePlaylistTitle,
  type YouTubeEnv,
} from './youtube';
import { getTikTokItem, isTikTokVideoUrl, type TikTokEnv } from './tiktok';

export interface FeedsEnv extends YouTubeEnv, TikTokEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

type SessionUser = { id: string } | null;
type FeedsVariables = { user: SessionUser };

interface FeedRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  is_public: number;
  last_viewed_at: number | null;
  created_at: string;
  updated_at: string;
}
interface SourceRow {
  id: string;
  feed_id: string;
  kind: FeedSourceKind;
  ref: string;
  label: string;
  position: number;
  added_at: string;
}

const FEED_SELECT =
  'SELECT id, user_id, name, description, is_public, last_viewed_at, created_at, updated_at FROM feeds';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  is_public: z.boolean().optional(),
});
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  is_public: z.boolean().optional(),
});

function publicFeed(f: FeedRow) {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    is_public: f.is_public,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

async function loadFeed(env: FeedsEnv, id: string): Promise<FeedRow | null> {
  return env.DB.prepare(`${FEED_SELECT} WHERE id = ?`).bind(id).first<FeedRow>();
}

export const feedRoutes = new Hono<{ Bindings: FeedsEnv; Variables: FeedsVariables }>();

feedRoutes.post('/api/feeds', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO feeds (id, user_id, name, description, is_public) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, parsed.data.name, parsed.data.description ?? '', parsed.data.is_public ? 1 : 0)
    .run();
  const feed = await loadFeed(c.env, id);
  return c.json({ feed: feed ? publicFeed(feed) : null });
});

feedRoutes.get('/api/feeds', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `${FEED_SELECT} WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all<FeedRow>();
  return c.json({ feeds: (results ?? []).map(publicFeed) });
});

feedRoutes.get('/api/feeds/:id', async (c) => {
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  const user = c.get('user');
  const isOwner = user?.id === feed.user_id;
  if (!feed.is_public && !isOwner) return c.json({ error: 'Feed not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, feed_id, kind, ref, label, position, added_at FROM feed_sources WHERE feed_id = ? ORDER BY position ASC, added_at ASC`,
  )
    .bind(feed.id)
    .all<SourceRow>();
  const sources = (results ?? []).map((s) => ({ id: s.id, kind: s.kind, ref: s.ref, label: s.label }));
  return c.json({ feed: { ...publicFeed(feed), is_owner: isOwner }, sources });
});

feedRoutes.patch('/api/feeds/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const name = parsed.data.name ?? feed.name;
  const description = parsed.data.description ?? feed.description;
  const isPublic = parsed.data.is_public === undefined ? feed.is_public : parsed.data.is_public ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE feeds SET name = ?, description = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(name, description, isPublic, feed.id)
    .run();
  const updated = await loadFeed(c.env, feed.id);
  return c.json({ feed: updated ? publicFeed(updated) : null });
});

feedRoutes.delete('/api/feeds/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM feed_sources WHERE feed_id = ?`).bind(feed.id),
    c.env.DB.prepare(`DELETE FROM feeds WHERE id = ?`).bind(feed.id),
  ]);
  return c.json({ ok: true });
});
