import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { feedRoutes, type FeedsEnv } from './feeds';

// ---- compact in-memory D1 + KV doubles (shared by all feeds tests) ----------

interface FeedRow {
  id: string; user_id: string; name: string; description: string;
  is_public: number; last_viewed_at: number | null; created_at: string; updated_at: string;
}
interface SourceRow {
  id: string; feed_id: string; kind: string; ref: string; label: string; position: number; added_at: string;
}
interface Store {
  feeds: FeedRow[];
  feed_sources: SourceRow[];
  users: Array<{ id: string; username: string; label: string }>;
  videos: Array<{ id: string; user_id: string; title: string; thumbnail_url: string | null; created_at: string; author: string }>;
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function fakeDB(store: Store): D1Database {
  function prep(sql: string, binds: unknown[] = []) {
    const q = norm(sql);
    return {
      bind: (...vals: unknown[]) => prep(sql, vals),
      first: async <T>() => {
        if (q.startsWith('SELECT id, user_id, name, description, is_public, last_viewed_at') && q.includes('FROM feeds WHERE id = ?')) {
          return (store.feeds.find((f) => f.id === binds[0]) ?? null) as T | null;
        }
        if (q.includes('FROM user WHERE username = ?')) {
          const u = store.users.find((x) => x.username === binds[0]);
          return (u ? { id: u.id, label: u.label } : null) as T | null;
        }
        return null;
      },
      all: async <T>() => {
        if (q.includes('FROM feeds WHERE user_id = ?')) {
          return { results: store.feeds.filter((f) => f.user_id === binds[0]) as T[] };
        }
        if (q.includes('FROM feed_sources WHERE feed_id = ?')) {
          return { results: store.feed_sources.filter((s) => s.feed_id === binds[0]) as T[] };
        }
        if (q.includes('FROM videos')) {
          // spooool channel items query: filter by user_id (first bind param)
          const userId = binds[0] as string;
          const rows = store.videos
            .filter((v) => v.user_id === userId)
            .map((v) => ({ id: v.id, title: v.title, thumbnail_url: v.thumbnail_url, created_at: v.created_at, author: v.author }));
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => {
        if (q.startsWith('INSERT INTO feeds')) {
          const [id, user_id, name, description, is_public] = binds as [string, string, string, string, number];
          store.feeds.push({ id, user_id, name, description, is_public, last_viewed_at: null, created_at: 't', updated_at: 't' });
        } else if (q.startsWith('UPDATE feeds SET name')) {
          // SQL: UPDATE feeds SET name=?, description=?, is_public=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
          // updated_at is a literal, not a bind param — only 4 bind params total.
          const [name, description, is_public, id] = binds as [string, string, number, string];
          const f = store.feeds.find((x) => x.id === id);
          if (f) { f.name = name; f.description = description; f.is_public = is_public; }
        } else if (q.startsWith('UPDATE feeds SET last_viewed_at')) {
          const f = store.feeds.find((x) => x.id === binds[1]);
          if (f) f.last_viewed_at = binds[0] as number;
        } else if (q.startsWith('DELETE FROM feed_sources WHERE feed_id = ?')) {
          store.feed_sources = store.feed_sources.filter((s) => s.feed_id !== binds[0]);
        } else if (q.startsWith('DELETE FROM feeds WHERE id = ?')) {
          store.feeds = store.feeds.filter((f) => f.id !== binds[0]);
        } else if (q.startsWith('INSERT INTO feed_sources')) {
          const [id, feed_id, kind, ref, label] = binds as [string, string, string, string, string];
          store.feed_sources.push({ id, feed_id, kind, ref, label, position: 0, added_at: 't' });
        } else if (q.startsWith('DELETE FROM feed_sources WHERE id = ?')) {
          store.feed_sources = store.feed_sources.filter((s) => s.id !== binds[0]);
        }
        return { success: true };
      },
    };
  }
  return {
    prepare: (sql: string) => prep(sql),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
      return [];
    },
  } as unknown as D1Database;
}

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

function emptyStore(): Store {
  return { feeds: [], feed_sources: [], users: [], videos: [] };
}

function makeApp(store: Store, user: { id: string } | null) {
  const env: FeedsEnv = { DB: fakeDB(store), CACHE: fakeKV() };
  // Mimic index.ts middleware that sets c.get('user').
  const app = new Hono();
  app.use('*', async (c: any, next: any) => { c.set('user', user); await next(); });
  app.route('/', feedRoutes);
  return { app, env };
}

async function call(store: Store, user: { id: string } | null, method: string, path: string, body?: unknown) {
  const { app, env } = makeApp(store, user);
  const req = new Request(`http://x${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.fetch(req, env);
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

// ---- CRUD tests --------------------------------------------------------------

describe('feeds CRUD', () => {
  it('requires auth to create', async () => {
    const store = emptyStore();
    const res = await call(store, null, 'POST', '/api/feeds', { name: 'My Feed' });
    expect(res.status).toBe(401);
  });

  it('creates, lists, gets, patches, and deletes a feed', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };

    const created = await call(store, user, 'POST', '/api/feeds', { name: 'My Feed' });
    expect(created.status).toBe(200);
    const id = created.json.feed.id as string;
    expect(created.json.feed).toMatchObject({ name: 'My Feed', is_public: 0 });

    const list = await call(store, user, 'GET', '/api/feeds');
    expect(list.json.feeds).toHaveLength(1);

    const got = await call(store, user, 'GET', `/api/feeds/${id}`);
    expect(got.json.feed.id).toBe(id);
    expect(got.json.sources).toEqual([]);

    const patched = await call(store, user, 'PATCH', `/api/feeds/${id}`, { name: 'Renamed', is_public: true });
    expect(patched.json.feed).toMatchObject({ name: 'Renamed', is_public: 1 });

    const del = await call(store, user, 'DELETE', `/api/feeds/${id}`);
    expect(del.status).toBe(200);
    const listAfter = await call(store, user, 'GET', '/api/feeds');
    expect(listAfter.json.feeds).toHaveLength(0);
  });

  it('rejects body without a name', async () => {
    const store = emptyStore();
    const res = await call(store, { id: 'u1' }, 'POST', '/api/feeds', { description: 'x' });
    expect(res.status).toBe(400);
  });

  it('hides a private feed from non-owners but shows a public one', async () => {
    const store = emptyStore();
    const owner = { id: 'owner' };
    const created = await call(store, owner, 'POST', '/api/feeds', { name: 'Secret' });
    const id = created.json.feed.id as string;

    const stranger = { id: 'other' };
    expect((await call(store, stranger, 'GET', `/api/feeds/${id}`)).status).toBe(404);

    await call(store, owner, 'PATCH', `/api/feeds/${id}`, { is_public: true });
    expect((await call(store, stranger, 'GET', `/api/feeds/${id}`)).status).toBe(200);
    expect((await call(store, null, 'GET', `/api/feeds/${id}`)).status).toBe(200);
  });

  it('forbids editing someone else’s feed', async () => {
    const store = emptyStore();
    const created = await call(store, { id: 'owner' }, 'POST', '/api/feeds', { name: 'Mine' });
    const id = created.json.feed.id as string;
    expect((await call(store, { id: 'other' }, 'PATCH', `/api/feeds/${id}`, { name: 'hax' })).status).toBe(403);
    expect((await call(store, { id: 'other' }, 'DELETE', `/api/feeds/${id}`)).status).toBe(403);
  });
});

describe('feed sources', () => {
  it('adds a spooool_channel source resolved from a username', async () => {
    const store = emptyStore();
    store.users.push({ id: 'creator1', username: 'cool', label: 'Cool Creator' });
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;

    const added = await call(store, user, 'POST', `/api/feeds/${id}/sources`, {
      kind: 'spooool_channel',
      ref: 'cool',
    });
    expect(added.status).toBe(200);
    expect(added.json.source).toMatchObject({ kind: 'spooool_channel', ref: 'creator1', label: 'Cool Creator' });
  });

  it('rejects a spooool_channel for an unknown username', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const res = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'spooool_channel',
      ref: 'ghost',
    });
    expect(res.status).toBe(400);
  });

  it('adds a youtube_search source (no resolution needed)', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const res = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'youtube_search',
      ref: 'lofi beats',
    });
    expect(res.status).toBe(200);
    expect(res.json.source).toMatchObject({ kind: 'youtube_search', ref: 'lofi beats' });
  });

  it('validates a tiktok_video URL', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const ok = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'tiktok_video',
      ref: 'https://www.tiktok.com/@u/video/7300000000000000000',
    });
    expect(ok.status).toBe(200);
    const bad = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'tiktok_video',
      ref: 'https://example.com/x',
    });
    expect(bad.status).toBe(400);
  });

  it('rejects an unparseable youtube_playlist ref', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const res = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'youtube_playlist',
      ref: 'not a playlist',
    });
    expect(res.status).toBe(400);
  });

  it('only the owner can add or remove sources', async () => {
    const store = emptyStore();
    const owner = { id: 'owner' };
    const feed = await call(store, owner, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;
    const added = await call(store, owner, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_search', ref: 'x' });
    const sid = added.json.source.id as string;

    expect((await call(store, { id: 'other' }, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_search', ref: 'y' })).status).toBe(403);
    expect((await call(store, { id: 'other' }, 'DELETE', `/api/feeds/${id}/sources/${sid}`)).status).toBe(403);
    expect((await call(store, owner, 'DELETE', `/api/feeds/${id}/sources/${sid}`)).status).toBe(200);
  });
});

async function callWith(env: FeedsEnv, store: Store, user: { id: string } | null, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => { c.set('user', user); await next(); });
  app.route('/', feedRoutes);
  const req = new Request(`http://x${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.fetch(req, env);
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

describe('feed items assembly', () => {
  function ytItem(id: string, publishedAt: number) {
    return {
      source: 'youtube', id, title: `t-${id}`, author: 'chan', thumbnailUrl: null,
      publishedAt, durationSec: null, url: `https://www.youtube.com/watch?v=${id}`,
      embed: { kind: 'youtube', videoId: id },
    };
  }

  it('merges spooool + cached youtube items newest-first and touches last_viewed_at', async () => {
    const store = emptyStore();
    store.users.push({ id: 'creator1', username: 'cool', label: 'Cool Creator' });
    store.videos.push({
      id: 'spv1', user_id: 'creator1', title: 'Spool One', thumbnail_url: null,
      created_at: '2026-03-01 00:00:00', author: 'Cool Creator',
    });
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;
    await call(store, user, 'POST', `/api/feeds/${id}/sources`, { kind: 'spooool_channel', ref: 'cool' });
    await call(store, user, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_channel', ref: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });

    // Pre-seed the per-source KV cache the YouTube client uses, so no network.
    const { env } = makeApp(store, user);
    await env.CACHE.put('yt:channel:UCX6OQ3DkcsbYNE6H8uQQuVA', JSON.stringify([ytItem('yt_new', Date.parse('2026-04-01T00:00:00Z'))]));

    const res = await callWith(env, store, user, 'GET', `/api/feeds/${id}/items`);
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: any) => i.id)).toEqual(['yt_new', 'spv1']);
    expect(store.feeds.find((f) => f.id === id)!.last_viewed_at).not.toBeNull();
  });

  it('keeps the feed alive when one source errors', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;
    await call(store, user, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_search', ref: 'breaks' });

    const { env } = makeApp(store, user);
    // No cache seeded + search uses real fetch → produce path throws → error result,
    // but the endpoint must still return 200 with a per-source error flag.
    // Force the failure deterministically by stubbing fetch to reject.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    try {
      const res = await callWith(env, store, user, 'GET', `/api/feeds/${id}/items`);
      expect(res.status).toBe(200);
      expect(res.json.items).toEqual([]);
      expect(res.json.sources.some((s: any) => s.error)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
