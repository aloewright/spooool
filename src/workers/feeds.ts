import { Hono } from 'hono';
import { z } from 'zod';
import { waitUntilBackground } from './wait-until';
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
import { aggregateSearch, ALL_PROVIDERS, type DiscoverEnv, type ProviderKey } from './discover';

export interface FeedsEnv extends YouTubeEnv, TikTokEnv, DiscoverEnv {
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
  kind: z.enum(['spooool_channel', 'youtube_channel', 'youtube_playlist', 'youtube_search', 'tiktok_video', 'web_search']),
  ref: z.string().min(1).max(2048),
});
const itemsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(24),
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

export function parseWebSearchRef(ref: string): { q: string; providers: ProviderKey[] } {
  try {
    const parsed = JSON.parse(ref) as { q?: string; providers?: string[] };
    const providers = (parsed.providers ?? []).filter((p): p is ProviderKey =>
      (ALL_PROVIDERS as string[]).includes(p),
    );
    if (typeof parsed.q === 'string' && parsed.q.trim().length > 0) {
      return { q: parsed.q, providers: providers.length ? providers : [...ALL_PROVIDERS] };
    }
  } catch {
    // not JSON — treat the whole ref as the query
  }
  return { q: ref, providers: [...ALL_PROVIDERS] };
}

const YT_PER_SOURCE = 15;

async function spoooolChannelItems(env: FeedsEnv, userId: string): Promise<FeedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.title, v.thumbnail_url, v.created_at, COALESCE(u.displayName, u.name) AS author
     FROM videos v LEFT JOIN user u ON u.id = v.user_id
     WHERE v.user_id = ? AND v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.dmca_status IS NULL
     ORDER BY v.created_at DESC LIMIT ?`,
  )
    .bind(userId, YT_PER_SOURCE)
    .all<{ id: string; title: string; thumbnail_url: string | null; created_at: string; author: string | null }>();
  return (results ?? []).map((r) => ({
    source: 'spooool' as const,
    id: r.id,
    title: r.title,
    author: r.author ?? 'spooool',
    thumbnailUrl: r.thumbnail_url,
    publishedAt: parseSqliteTimestamp(r.created_at),
    durationSec: null,
    url: `/watch/${r.id}`,
  }));
}

// Resolve one stored source row into a SourceResult. A failure degrades to an
// error result for that source only — never throws.
async function fetchSourceItems(env: FeedsEnv, s: SourceRow): Promise<SourceResult> {
  const base = { sourceId: s.id, kind: s.kind };
  try {
    if (s.kind === 'spooool_channel') {
      return { ...base, items: await spoooolChannelItems(env, s.ref) };
    }
    if (s.kind === 'youtube_channel') {
      const r = await getYouTubeChannelItems(env, s.ref);
      return { ...base, items: r.items, error: r.error, stale: r.stale };
    }
    if (s.kind === 'youtube_playlist') {
      const r = await getYouTubePlaylistItems(env, s.ref);
      return { ...base, items: r.items, error: r.error, stale: r.stale };
    }
    if (s.kind === 'youtube_search') {
      const r = await getYouTubeSearchItems(env, s.ref);
      return { ...base, items: r.items, error: r.error, stale: r.stale };
    }
    if (s.kind === 'web_search') {
      const { q, providers } = parseWebSearchRef(s.ref);
      const r = await aggregateSearch(env, { q, providers, order: 'date', cursor: null, limit: 15 });
      const error = r.providers.find((p) => p.error)?.error;
      return { ...base, items: r.items, error };
    }
    // tiktok_video
    const r = await getTikTokItem(env, s.ref, parseSqliteTimestamp(s.added_at));
    return { ...base, items: r.item ? [r.item] : [], error: r.error };
  } catch (err) {
    return { ...base, items: [], error: err instanceof Error ? err.message : 'source failed' };
  }
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
    // Bare channelId: store as-is without a network call. Label is the channel
    // ID itself (we don't have the title without an API call); a user who wants
    // the channel's title can re-add it via its @handle or URL.
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
  if (kind === 'web_search') {
    const { q, providers } = parseWebSearchRef(ref);
    return { ref: JSON.stringify({ q, providers }), label: `Web search: ${q}` };
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

feedRoutes.get('/api/feeds/:id/items', async (c) => {
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  const user = c.get('user');
  const isOwner = user?.id === feed.user_id;
  if (!feed.is_public && !isOwner) return c.json({ error: 'Feed not found' }, 404);

  const parsed = itemsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT id, feed_id, kind, ref, label, position, added_at FROM feed_sources WHERE feed_id = ? ORDER BY position ASC, added_at ASC`,
  )
    .bind(feed.id)
    .all<SourceRow>();
  const rows = results ?? [];

  const sourceResults = await Promise.all(rows.map((s) => fetchSourceItems(c.env, s)));
  const assembled = assembleFeed(sourceResults, parsed.data.cursor ?? null, parsed.data.limit);

  // Touch last_viewed_at so the cron warmer keeps this feed's caches fresh.
  // Fire-and-forget: the response doesn't depend on this write, and a missed
  // update at worst delays cache warming by one 5-minute cron cycle.
  waitUntilBackground(c, c.env.DB.prepare(`UPDATE feeds SET last_viewed_at = ? WHERE id = ?`)
    .bind(Date.now(), feed.id)
    .run()
    .catch((err) => console.warn('[feeds] last_viewed_at update failed', { feedId: feed.id, error: String(err) })));

  // Enrich the source summary with labels for the manage panel.
  const labelById = new Map(rows.map((r) => [r.id, r.label]));
  const sources = assembled.sources.map((s) => ({ ...s, label: labelById.get(s.sourceId) ?? '' }));

  return c.json({
    feed: { ...publicFeed(feed), is_owner: isOwner },
    items: assembled.items,
    nextCursor: assembled.nextCursor,
    sources,
  });
});
