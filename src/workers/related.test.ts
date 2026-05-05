import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { relatedRoutes, relatedCacheKey, type RelatedEnv } from './related';

interface VideoRow {
  id: string;
  user_id: string;
  title: string;
  thumbnail_url: string | null;
  view_count: number;
  created_at: string;
  status: string;
  deleted_at: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
  channel_name: string | null;
  channel_username: string | null;
}

function row(partial: Partial<VideoRow>): VideoRow {
  return {
    id: 'v',
    user_id: 'u1',
    title: 'A video',
    thumbnail_url: null,
    view_count: 0,
    created_at: '2026-05-01T00:00:00Z',
    status: 'ready',
    deleted_at: null,
    hidden_at: null,
    dmca_status: null,
    channel_name: 'Alice',
    channel_username: 'alice',
    ...partial,
  };
}

interface PreparedStmt {
  bind: (...values: unknown[]) => PreparedStmt;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean }>;
}

interface FakeDBResult {
  db: D1Database;
  prepares: string[];
  binds: unknown[][];
}

// Hand-rolled D1 stub keyed on SQL fragments the route actually issues. New
// queries must be added explicitly so a schema change can never silently fall
// through.
function fakeDB(videos: VideoRow[]): FakeDBResult {
  const prepares: string[] = [];
  const binds: unknown[][] = [];

  function isViewable(v: VideoRow): boolean {
    return (
      v.deleted_at === null &&
      v.hidden_at === null &&
      v.status === 'ready' &&
      (v.dmca_status === null || v.dmca_status !== 'disabled')
    );
  }

  const prepare = (sql: string): PreparedStmt => {
    prepares.push(sql);
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values) {
        args = values;
        binds.push(values);
        return stmt;
      },
      first: async <T,>() => {
        if (sql.includes('SELECT id, user_id, title FROM videos')) {
          const [id] = args as [string];
          const v = videos.find(
            (x) =>
              x.id === id &&
              x.deleted_at === null &&
              x.hidden_at === null &&
              (x.dmca_status === null || x.dmca_status !== 'disabled'),
          );
          return v
            ? (({ id: v.id, user_id: v.user_id, title: v.title }) as unknown as T)
            : null;
        }
        return null;
      },
      all: async <T,>() => {
        if (sql.includes("WHERE v.user_id = ? AND v.id != ?")) {
          const [userId, sourceId, limit] = args as [string, string, number];
          const out = videos
            .filter((v) => v.user_id === userId && v.id !== sourceId && isViewable(v))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit)
            .map(asProjected);
          return { results: out as T[] };
        }
        if (sql.includes('FROM videos_fts')) {
          // args: ftsQuery, ...seenIds, remaining
          const [, ...rest] = args as [string, ...unknown[]];
          const remaining = rest[rest.length - 1] as number;
          const seen = rest.slice(0, -1) as string[];
          const out = videos
            .filter((v) => isViewable(v) && !seen.includes(v.id))
            .slice(0, remaining)
            .map(asProjected);
          return { results: out as T[] };
        }
        if (sql.includes('ORDER BY v.view_count DESC, v.created_at DESC')) {
          // args: ...seenIds, remaining
          const remaining = args[args.length - 1] as number;
          const seen = args.slice(0, -1) as string[];
          const out = videos
            .filter((v) => isViewable(v) && !seen.includes(v.id))
            .sort((a, b) =>
              b.view_count - a.view_count ||
              b.created_at.localeCompare(a.created_at),
            )
            .slice(0, remaining)
            .map(asProjected);
          return { results: out as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => ({ success: true }),
    };
    return stmt;
  };

  return { db: { prepare } as unknown as D1Database, prepares, binds };
}

function asProjected(v: VideoRow): {
  id: string;
  title: string;
  thumbnail_url: string | null;
  view_count: number;
  created_at: string;
  channel_name: string | null;
  channel_username: string | null;
} {
  return {
    id: v.id,
    title: v.title,
    thumbnail_url: v.thumbnail_url,
    view_count: v.view_count,
    created_at: v.created_at,
    channel_name: v.channel_name,
    channel_username: v.channel_username,
  };
}

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: 'json' | 'text') {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
  } as unknown as KVNamespace;
}

function buildApp(env: RelatedEnv) {
  const app = new Hono<{ Bindings: RelatedEnv; Variables: { user: null } }>();
  app.use('*', async (c, next) => {
    c.set('user', null);
    await next();
  });
  app.route('/', relatedRoutes);
  return (path: string) => app.request(path, {}, env);
}

describe('relatedCacheKey', () => {
  it('namespaces by id and limit', () => {
    expect(relatedCacheKey('abc', 12)).toBe('related:v1:abc:limit=12');
    expect(relatedCacheKey('abc', 24)).toBe('related:v1:abc:limit=24');
  });
});

describe('GET /api/videos/:id/related', () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = fakeKV();
  });

  it('400s on non-positive or oversized limit', async () => {
    const { db } = fakeDB([]);
    const request = buildApp({ DB: db, CACHE: kv });
    expect((await request('/api/videos/v1/related?limit=0')).status).toBe(400);
    expect((await request('/api/videos/v1/related?limit=999')).status).toBe(400);
  });

  it('404s when the source video is missing or not viewable', async () => {
    const videos = [row({ id: 'gone', deleted_at: '2026-04-01' })];
    const { db } = fakeDB(videos);
    const res = await buildApp({ DB: db, CACHE: kv })('/api/videos/gone/related');
    expect(res.status).toBe(404);
  });

  it('returns same-channel videos first, excluding the source', async () => {
    const videos = [
      row({ id: 'src', user_id: 'u1', created_at: '2026-04-30T00:00:00Z', title: 'Cooking pasta basics' }),
      row({ id: 'a', user_id: 'u1', created_at: '2026-04-20T00:00:00Z', title: 'Sauce 101' }),
      row({ id: 'b', user_id: 'u1', created_at: '2026-04-25T00:00:00Z', title: 'Knife skills' }),
      row({ id: 'c', user_id: 'u2', created_at: '2026-04-29T00:00:00Z', title: 'Different channel' }),
    ];
    const { db } = fakeDB(videos);
    const res = await buildApp({ DB: db, CACHE: kv })('/api/videos/src/related?limit=12');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videos: { id: string }[] };
    const ids = body.videos.map((v) => v.id);
    expect(ids[0]).toBe('b');
    expect(ids[1]).toBe('a');
    expect(ids).not.toContain('src');
  });

  it('falls through to FTS5 then trending top-up to fill the limit', async () => {
    const videos = [
      row({ id: 'src', user_id: 'u1', title: 'Cooking pasta', view_count: 100 }),
      // No same-channel sibling.
      row({ id: 'fts1', user_id: 'u3', title: 'unrelated', view_count: 50 }),
      row({ id: 'fts2', user_id: 'u4', title: 'also unrelated', view_count: 200 }),
    ];
    const { db, prepares } = fakeDB(videos);
    const res = await buildApp({ DB: db, CACHE: kv })('/api/videos/src/related?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videos: { id: string }[] };
    expect(body.videos).toHaveLength(2);
    // FTS5 is consulted because same-channel returned 0 rows.
    expect(prepares.some((q) => q.includes('FROM videos_fts'))).toBe(true);
  });

  it('filters out hidden, soft-deleted, non-ready, and DMCA-disabled rows', async () => {
    const videos = [
      row({ id: 'src', user_id: 'u1', title: 'Source' }),
      row({ id: 'ok', user_id: 'u1', created_at: '2026-04-29' }),
      row({ id: 'hidden', user_id: 'u1', hidden_at: '2026-04-28' }),
      row({ id: 'gone', user_id: 'u1', deleted_at: '2026-04-28' }),
      row({ id: 'pending', user_id: 'u1', status: 'encoding' }),
      row({ id: 'dmca', user_id: 'u1', dmca_status: 'disabled' }),
    ];
    const { db } = fakeDB(videos);
    const res = await buildApp({ DB: db, CACHE: kv })('/api/videos/src/related?limit=12');
    const body = (await res.json()) as { videos: { id: string }[] };
    const ids = body.videos.map((v) => v.id);
    expect(ids).toContain('ok');
    expect(ids).not.toContain('hidden');
    expect(ids).not.toContain('gone');
    expect(ids).not.toContain('pending');
    expect(ids).not.toContain('dmca');
  });

  it('caches the response and serves cached=true on the second hit', async () => {
    const videos = [
      row({ id: 'src', user_id: 'u1', title: 'Source' }),
      row({ id: 'a', user_id: 'u1', created_at: '2026-04-29' }),
    ];
    const { db } = fakeDB(videos);
    const request = buildApp({ DB: db, CACHE: kv });
    const first = await request('/api/videos/src/related?limit=12');
    expect(first.headers.get('x-spooool-cache')).toBe('miss');
    const firstBody = (await first.json()) as { cached: boolean };
    expect(firstBody.cached).toBe(false);

    const second = await request('/api/videos/src/related?limit=12');
    expect(second.headers.get('x-spooool-cache')).toBe('hit');
    const secondBody = (await second.json()) as { cached: boolean };
    expect(secondBody.cached).toBe(true);
  });

  it('uses the default limit of 12 when none is provided', async () => {
    const videos = [row({ id: 'src', user_id: 'u1' })];
    const { db, binds } = fakeDB(videos);
    await buildApp({ DB: db, CACHE: kv })('/api/videos/src/related');
    // First non-source bind is the same-channel query: [user_id, source_id, limit]
    const sameChannelBind = binds.find(
      (b) => b.length === 3 && b[1] === 'src' && typeof b[2] === 'number',
    );
    expect(sameChannelBind?.[2]).toBe(12);
  });
});
