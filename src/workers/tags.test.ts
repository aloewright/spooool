import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  TAG_LIMITS,
  dedupeTags,
  normaliseTagInput,
  tagRoutes,
  type TagsEnv,
} from './tags';

describe('normaliseTagInput', () => {
  it('lowercases and slugifies whitespace + punctuation', () => {
    expect(normaliseTagInput('  Music & Beats  ')).toEqual({
      slug: 'music-beats',
      label: 'Music & Beats',
    });
  });
  it('trims surrounding hyphens', () => {
    expect(normaliseTagInput('--Foo!--')).toEqual({ slug: 'foo', label: '--Foo!--' });
  });
  it('returns null for empty / pure-symbol input', () => {
    expect(normaliseTagInput('   ')).toBeNull();
    expect(normaliseTagInput('!!!')).toBeNull();
    expect(normaliseTagInput('')).toBeNull();
  });
  it('caps label length to TAG_LABEL_MAX', () => {
    const long = 'a'.repeat(100);
    const tag = normaliseTagInput(long);
    if (!tag) throw new Error('expected non-null tag');
    expect(tag.label).toHaveLength(TAG_LIMITS.TAG_LABEL_MAX);
    expect(tag.slug).toHaveLength(TAG_LIMITS.TAG_LABEL_MAX);
  });
});

describe('dedupeTags', () => {
  it('keeps the first occurrence per slug', () => {
    const out = dedupeTags([
      { slug: 'music', label: 'Music' },
      { slug: 'music', label: 'MUSIC' },
      { slug: 'art', label: 'Art' },
    ]);
    expect(out).toEqual([
      { slug: 'music', label: 'Music' },
      { slug: 'art', label: 'Art' },
    ]);
  });
});

// --- HTTP handler smoke tests --------------------------------------------------

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface FakeStore {
  videos: Array<{
    id: string;
    user_id: string;
    title: string;
    description: string;
    thumbnail_url: string | null;
    view_count: number;
    created_at: string;
    deleted_at: string | null;
    hidden_at: string | null;
    dmca_status: string | null;
  }>;
  users: Array<{ id: string; name: string; username: string }>;
  tags: Array<{ slug: string; label: string }>;
  videoTags: Array<{ video_id: string; tag_slug: string }>;
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function fakeDB(store: FakeStore): D1Database {
  function prepare(sql: string): PreparedStmt {
    const q = flat(sql);
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values: unknown[]) {
        args = values;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (q.startsWith('SELECT slug, label FROM tags WHERE slug = ?')) {
          const [slug] = args as [string];
          const t = store.tags.find((x) => x.slug === slug);
          return (t ? ({ slug: t.slug, label: t.label } as unknown as T) : null);
        }
        if (q.startsWith('SELECT user_id FROM videos WHERE id = ?')) {
          const [id] = args as [string];
          const v = store.videos.find((x) => x.id === id && x.deleted_at === null);
          return (v ? ({ user_id: v.user_id } as unknown as T) : null);
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (q.startsWith('SELECT t.slug, t.label, COUNT(vt.video_id)')) {
          const [limit] = args as [number];
          const counts = new Map<string, number>();
          for (const vt of store.videoTags) {
            const v = store.videos.find((x) => x.id === vt.video_id);
            if (!v || v.deleted_at || v.hidden_at || v.dmca_status) continue;
            counts.set(vt.tag_slug, (counts.get(vt.tag_slug) ?? 0) + 1);
          }
          const rows = Array.from(counts.entries())
            .map(([slug, video_count]) => {
              const t = store.tags.find((x) => x.slug === slug);
              return t ? { slug: t.slug, label: t.label, video_count } : null;
            })
            .filter(
              (r): r is { slug: string; label: string; video_count: number } =>
                r !== null && r.video_count > 0,
            )
            .sort(
              (a, b) => b.video_count - a.video_count || a.slug.localeCompare(b.slug),
            )
            .slice(0, limit);
          return { results: rows as unknown as T[] };
        }
        if (q.startsWith('SELECT v.id, v.user_id, v.title') && q.includes('JOIN video_tags vt')) {
          const [slug, limit, offset] = args as [string, number, number];
          const ids = store.videoTags.filter((vt) => vt.tag_slug === slug).map((vt) => vt.video_id);
          const rows = store.videos
            .filter(
              (v) =>
                ids.includes(v.id) && !v.deleted_at && !v.hidden_at && !v.dmca_status,
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(offset, offset + limit)
            .map((v) => {
              const u = store.users.find((x) => x.id === v.user_id);
              return {
                id: v.id,
                user_id: v.user_id,
                title: v.title,
                description: v.description,
                thumbnail_url: v.thumbnail_url,
                view_count: v.view_count,
                created_at: v.created_at,
                channel_name: u?.name ?? null,
                channel_username: u?.username ?? null,
              };
            });
          return { results: rows as unknown as T[] };
        }
        if (
          q.startsWith('SELECT t.slug, t.label FROM video_tags vt') &&
          q.includes('WHERE vt.video_id = ?')
        ) {
          const [videoId] = args as [string];
          const slugs = store.videoTags
            .filter((vt) => vt.video_id === videoId)
            .map((vt) => vt.tag_slug);
          const rows = store.tags
            .filter((t) => slugs.includes(t.slug))
            .sort((a, b) => a.label.localeCompare(b.label));
          return { results: rows as unknown as T[] };
        }
        return { results: [] };
      },
      async run() {
        return { success: true };
      },
    };
    return stmt;
  }
  return {
    prepare,
    async batch(stmts: D1PreparedStatement[]) {
      // For PUT /api/videos/:id/tags we just need batch to resolve. The actual
      // mutation contracts are exercised by the worker integration tests in
      // ALO-189.
      return stmts.map(() => ({ success: true })) as never;
    },
  } as unknown as D1Database;
}

type SessionUser = { id: string; name: string; email: string } | null;

function makeApp(store: FakeStore, user: SessionUser) {
  const app = new Hono<{ Bindings: TagsEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', tagRoutes);
  return async (path: string, init?: RequestInit) => {
    const env: TagsEnv = { DB: fakeDB(store) };
    return app.request(path, init, env);
  };
}

describe('GET /api/tags', () => {
  it('returns top tags by visible video count', async () => {
    const store: FakeStore = {
      users: [{ id: 'u1', name: 'Alice', username: 'alice' }],
      videos: [
        { id: 'v1', user_id: 'u1', title: 'a', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-01', deleted_at: null, hidden_at: null, dmca_status: null },
        { id: 'v2', user_id: 'u1', title: 'b', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-02', deleted_at: null, hidden_at: null, dmca_status: null },
        { id: 'v3', user_id: 'u1', title: 'c', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-03', deleted_at: null, hidden_at: 'x', dmca_status: null },
      ],
      tags: [
        { slug: 'music', label: 'Music' },
        { slug: 'art', label: 'Art' },
      ],
      videoTags: [
        { video_id: 'v1', tag_slug: 'music' },
        { video_id: 'v2', tag_slug: 'music' },
        { video_id: 'v3', tag_slug: 'art' },
      ],
    };
    const fetchApp = makeApp(store, null);
    const res = await fetchApp('/api/tags');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: Array<{ slug: string; video_count: number }> };
    expect(body.tags).toEqual([{ slug: 'music', label: 'Music', video_count: 2 }]);
  });
});

describe('GET /api/tags/:slug', () => {
  it('returns 404 when the tag does not exist', async () => {
    const store: FakeStore = { users: [], videos: [], tags: [], videoTags: [] };
    const fetchApp = makeApp(store, null);
    const res = await fetchApp('/api/tags/nope');
    expect(res.status).toBe(404);
  });

  it('returns paged videos newest-first', async () => {
    const store: FakeStore = {
      users: [{ id: 'u1', name: 'Alice', username: 'alice' }],
      videos: [
        { id: 'v1', user_id: 'u1', title: 'first', description: '', thumbnail_url: null, view_count: 1, created_at: '2026-01-01', deleted_at: null, hidden_at: null, dmca_status: null },
        { id: 'v2', user_id: 'u1', title: 'second', description: '', thumbnail_url: null, view_count: 2, created_at: '2026-02-01', deleted_at: null, hidden_at: null, dmca_status: null },
      ],
      tags: [{ slug: 'music', label: 'Music' }],
      videoTags: [
        { video_id: 'v1', tag_slug: 'music' },
        { video_id: 'v2', tag_slug: 'music' },
      ],
    };
    const fetchApp = makeApp(store, null);
    const res = await fetchApp('/api/tags/music');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tag: { slug: string; label: string };
      videos: Array<{ id: string; channel_username: string | null }>;
    };
    expect(body.tag).toEqual({ slug: 'music', label: 'Music' });
    expect(body.videos.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(body.videos[0]?.channel_username).toBe('alice');
  });
});

describe('PUT /api/videos/:id/tags', () => {
  it('rejects anonymous callers with 401', async () => {
    const store: FakeStore = {
      users: [],
      videos: [
        { id: 'v1', user_id: 'u1', title: 'x', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-01', deleted_at: null, hidden_at: null, dmca_status: null },
      ],
      tags: [],
      videoTags: [],
    };
    const fetchApp = makeApp(store, null);
    const res = await fetchApp('/api/videos/v1/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['Music'] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-owner callers with 403', async () => {
    const store: FakeStore = {
      users: [{ id: 'u2', name: 'Bob', username: 'bob' }],
      videos: [
        { id: 'v1', user_id: 'u1', title: 'x', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-01', deleted_at: null, hidden_at: null, dmca_status: null },
      ],
      tags: [],
      videoTags: [],
    };
    const fetchApp = makeApp(store, { id: 'u2', name: 'Bob', email: 'bob@example.com' });
    const res = await fetchApp('/api/videos/v1/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['Music'] }),
    });
    expect(res.status).toBe(403);
  });

  it('returns the normalised, deduped, capped tag list to the owner', async () => {
    const store: FakeStore = {
      users: [{ id: 'u1', name: 'Alice', username: 'alice' }],
      videos: [
        { id: 'v1', user_id: 'u1', title: 'x', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-01', deleted_at: null, hidden_at: null, dmca_status: null },
      ],
      tags: [],
      videoTags: [],
    };
    const fetchApp = makeApp(store, { id: 'u1', name: 'Alice', email: 'alice@example.com' });
    const dupes = ['Music', 'music ', 'MUSIC', 'Art', '!!!', '   '];
    const res = await fetchApp('/api/videos/v1/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: dupes }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: Array<{ slug: string; label: string }> };
    expect(body.tags).toEqual([
      { slug: 'music', label: 'Music' },
      { slug: 'art', label: 'Art' },
    ]);
  });

  it('rejects bodies above MAX_TAGS_PER_VIDEO (validation, not silent truncation)', async () => {
    const store: FakeStore = {
      users: [{ id: 'u1', name: 'Alice', username: 'alice' }],
      videos: [
        { id: 'v1', user_id: 'u1', title: 'x', description: '', thumbnail_url: null, view_count: 0, created_at: '2026-01-01', deleted_at: null, hidden_at: null, dmca_status: null },
      ],
      tags: [],
      videoTags: [],
    };
    const fetchApp = makeApp(store, { id: 'u1', name: 'Alice', email: 'alice@example.com' });
    const res = await fetchApp('/api/videos/v1/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tags: Array.from({ length: TAG_LIMITS.MAX_TAGS_PER_VIDEO + 1 }, (_, i) => `tag-${i}`),
      }),
    });
    expect(res.status).toBe(400);
  });
});
