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

const addSourceSchema = z.object({
  kind: z.enum(['spooool_channel', 'youtube_channel', 'youtube_playlist', 'youtube_search', 'tiktok_video']),
  ref: z.string().min(1).max(2048),
});

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

// Validate + normalize a user-supplied source into the stored { ref, label }.
// Throws Error(message) on invalid input; the route maps that to a 400.
async function resolveSource(
  env: FeedsEnv,
  kind: FeedSourceKind,
  rawRef: string,
): Promise<{ ref: string; label: string }> {
  const ref = rawRef.trim();
  if (kind === 'spooool_channel') {
    const row = await env.DB.prepare(
      `SELECT id, COALESCE(displayName, name) AS label FROM user WHERE username = ?`,
    )
      .bind(ref)
      .first<{ id: string; label: string }>();
    if (!row) throw new Error('Unknown spooool channel');
    return { ref: row.id, label: row.label ?? ref };
  }
  if (kind === 'youtube_channel') {
    const parsed = parseChannelInput(ref);
    if (!parsed) throw new Error('Could not parse YouTube channel');
    // If we already have a channelId, store it directly to avoid an API call
    // for title resolution when YOUTUBE_API_KEY is absent (e.g., in tests or
    // at add-time before the key is configured). Title enrichment happens lazily
    // via the items endpoint which reads from the KV cache.
    if (parsed.by === 'id') {
      return { ref: parsed.channelId, label: parsed.channelId };
    }
    const { channelId, title } = await resolveYouTubeChannel(env, parsed);
    return { ref: channelId, label: title };
  }
  if (kind === 'youtube_playlist') {
    const playlistId = parsePlaylistInput(ref);
    if (!playlistId) throw new Error('Could not parse YouTube playlist');
    const title = await resolveYouTubePlaylistTitle(env, playlistId);
    return { ref: playlistId, label: title };
  }
  if (kind === 'youtube_search') {
    return { ref, label: `Search: ${ref}` };
  }
  // tiktok_video
  if (!isTikTokVideoUrl(ref)) throw new Error('Not a TikTok video URL');
  return { ref, label: 'TikTok video' };
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

feedRoutes.post('/api/feeds/:id/sources', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const parsed = addSourceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  let resolved: { ref: string; label: string };
  try {
    resolved = await resolveSource(c.env, parsed.data.kind, parsed.data.ref);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid source' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO feed_sources (id, feed_id, kind, ref, label) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, feed.id, parsed.data.kind, resolved.ref, resolved.label)
    .run();
  return c.json({ source: { id, kind: parsed.data.kind, ref: resolved.ref, label: resolved.label } });
});

feedRoutes.delete('/api/feeds/:id/sources/:sid', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.prepare(`DELETE FROM feed_sources WHERE id = ? AND feed_id = ?`)
    .bind(c.req.param('sid'), feed.id)
    .run();
  return c.json({ ok: true });
});
