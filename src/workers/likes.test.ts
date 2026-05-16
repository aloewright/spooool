import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { likeCountKey, likeRoutes, type LikesEnv } from './likes';

describe('likeCountKey', () => {
  it('namespaces likes by video id', () => {
    expect(likeCountKey('abc')).toBe('likes:v1:abc');
  });
});

// --- Fakes ---------------------------------------------------------------
//
// We mirror the fake-D1 + fake-KV pattern from `channels.test.ts` so this
// suite stays dependency-free (no miniflare, no real D1). The fakes track
// every prepare/bind call so each test can assert on call counts (e.g. cache
// hit ⇒ zero D1 reads for the count).

type Counters = { dbPrepare: number; kvGet: number; kvPut: number };

function fakeDB(opts: {
  videoExists?: boolean;
  hasLikeForUser?: boolean;
  // Total like count returned by COUNT(*). Decoupled from `hasLikeForUser`
  // so a test can model "video has 7 likes from other users; current viewer
  // has not liked".
  totalLikes?: number;
  // Override the post-toggle count returned by the COUNT(*) re-read on POST.
  // When omitted the fake derives it from the natural ±1 swing.
  countAfterToggle?: number;
  counters?: Counters;
  insertCalls?: { current: number };
  deleteCalls?: { current: number };
}): D1Database {
  const {
    videoExists = true,
    hasLikeForUser = false,
    totalLikes = hasLikeForUser ? 1 : 0,
    counters,
    insertCalls,
    deleteCalls,
  } = opts;
  let liked = hasLikeForUser;
  let count = totalLikes;
  const explicitCountAfterToggle = opts.countAfterToggle;

  const prepare = (sql: string) => {
    if (counters) counters.dbPrepare += 1;
    let bound: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        bound = values;
        return stmt;
      },
      first: async () => {
        if (/FROM videos WHERE id = \? AND deleted_at IS NULL/.test(sql)) {
          return videoExists ? { 1: 1 } : null;
        }
        if (/SELECT 1 FROM video_likes WHERE video_id = \? AND user_id = \?/.test(sql)) {
          return liked ? { 1: 1 } : null;
        }
        if (/SELECT COUNT\(\*\) AS c FROM video_likes/.test(sql)) {
          return { c: count };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => {
        if (/^INSERT INTO video_likes/.test(sql)) {
          if (!liked) {
            liked = true;
            count = explicitCountAfterToggle ?? count + 1;
          }
          if (insertCalls) insertCalls.current += 1;
        } else if (/^DELETE FROM video_likes/.test(sql)) {
          if (liked) {
            liked = false;
            count = explicitCountAfterToggle ?? Math.max(0, count - 1);
          }
          if (deleteCalls) deleteCalls.current += 1;
        }
        void bound;
        return { success: true };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };

  return { prepare } as unknown as D1Database;
}

function fakeCache(opts: { initial?: Record<string, string>; counters?: Counters }): KVNamespace {
  const store: Record<string, string> = { ...(opts.initial ?? {}) };
  return {
    get: async (key: string) => {
      if (opts.counters) opts.counters.kvGet += 1;
      return store[key] ?? null;
    },
    put: async (key: string, value: string) => {
      if (opts.counters) opts.counters.kvPut += 1;
      store[key] = String(value);
    },
  } as unknown as KVNamespace;
}

type SessionUser = { id: string } | null;

function buildApp(env: LikesEnv, user: SessionUser = null) {
  const app = new Hono<{ Bindings: LikesEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', likeRoutes);
  return (path: string, init?: RequestInit) => app.request(path, init, env);
}

// --- GET /api/videos/:id/like -------------------------------------------

describe('GET /api/videos/:id/like', () => {
  it('returns 404 when the video does not exist', async () => {
    const req = buildApp({
      DB: fakeDB({ videoExists: false }),
      CACHE: fakeCache({}),
    });
    const res = await req('/api/videos/missing/like');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Video not found' });
  });

  it('cache miss reads from D1 and writes the count back to KV', async () => {
    const counters: Counters = { dbPrepare: 0, kvGet: 0, kvPut: 0 };
    const req = buildApp({
      DB: fakeDB({ videoExists: true, counters }),
      CACHE: fakeCache({ counters }),
    });
    const res = await req('/api/videos/v1/like');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 0, liked: false });
    expect(counters.kvGet).toBe(1);
    expect(counters.kvPut).toBe(1);
  });

  it('cache hit returns the cached count without re-reading from D1', async () => {
    const counters: Counters = { dbPrepare: 0, kvGet: 0, kvPut: 0 };
    const req = buildApp({
      DB: fakeDB({ videoExists: true, counters }),
      CACHE: fakeCache({ initial: { 'likes:v1:v1': '42' }, counters }),
    });
    const res = await req('/api/videos/v1/like');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 42, liked: false });
    expect(counters.kvPut).toBe(0);
    // 1 D1 prepare: just the `videoExists` check. The per-user `liked` lookup
    // is skipped for anonymous viewers, and the COUNT(*) read is skipped
    // because the cache served the count.
    expect(counters.dbPrepare).toBe(1);
  });

  it('returns liked=true when the signed-in user has already liked the video', async () => {
    const req = buildApp(
      {
        DB: fakeDB({ videoExists: true, hasLikeForUser: true }),
        CACHE: fakeCache({ initial: { 'likes:v1:v1': '5' } }),
      },
      { id: 'user-1' },
    );
    const res = await req('/api/videos/v1/like');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 5, liked: true });
  });

  it('returns liked=false for anonymous viewers even when others have liked', async () => {
    const req = buildApp({
      DB: fakeDB({ videoExists: true, hasLikeForUser: true }),
      CACHE: fakeCache({ initial: { 'likes:v1:v1': '5' } }),
    });
    const res = await req('/api/videos/v1/like');
    const body = (await res.json()) as { liked: boolean; likes: number };
    expect(body.liked).toBe(false);
    expect(body.likes).toBe(5);
  });

  it('cache miss surfaces the true D1 count even when the viewer has no like', async () => {
    // Regression guard: previously the fake derived COUNT(*) from `liked`,
    // which made this scenario untestable. The route must report the real
    // total (7) for an anonymous viewer of a video that other users liked.
    const counters: Counters = { dbPrepare: 0, kvGet: 0, kvPut: 0 };
    const req = buildApp({
      DB: fakeDB({ videoExists: true, totalLikes: 7, counters }),
      CACHE: fakeCache({ counters }),
    });
    const res = await req('/api/videos/v1/like');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 7, liked: false });
    expect(counters.kvPut).toBe(1);
  });

  it('drops a malformed cached value and re-reads from D1', async () => {
    const counters: Counters = { dbPrepare: 0, kvGet: 0, kvPut: 0 };
    const req = buildApp({
      DB: fakeDB({ videoExists: true, counters }),
      CACHE: fakeCache({ initial: { 'likes:v1:v1': 'oops' }, counters }),
    });
    const res = await req('/api/videos/v1/like');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 0, liked: false });
    expect(counters.kvPut).toBe(1);
  });
});

// --- POST /api/videos/:id/like ------------------------------------------

describe('POST /api/videos/:id/like', () => {
  it('returns 401 when the caller is anonymous', async () => {
    const req = buildApp({
      DB: fakeDB({}),
      CACHE: fakeCache({}),
    });
    const res = await req('/api/videos/v1/like', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 when the video does not exist', async () => {
    const req = buildApp(
      {
        DB: fakeDB({ videoExists: false }),
        CACHE: fakeCache({}),
      },
      { id: 'user-1' },
    );
    const res = await req('/api/videos/missing/like', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('inserts a new like when none exists and returns liked=true', async () => {
    const inserts = { current: 0 };
    const deletes = { current: 0 };
    const counters: Counters = { dbPrepare: 0, kvGet: 0, kvPut: 0 };
    const req = buildApp(
      {
        DB: fakeDB({
          videoExists: true,
          hasLikeForUser: false,
          countAfterToggle: 1,
          insertCalls: inserts,
          deleteCalls: deletes,
        }),
        CACHE: fakeCache({ counters }),
      },
      { id: 'user-1' },
    );
    const res = await req('/api/videos/v1/like', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 1, liked: true });
    expect(inserts.current).toBe(1);
    expect(deletes.current).toBe(0);
    // POST always refreshes the cached count from D1 — never relies on a delta.
    expect(counters.kvPut).toBe(1);
  });

  it('deletes an existing like and returns liked=false', async () => {
    const inserts = { current: 0 };
    const deletes = { current: 0 };
    const counters: Counters = { dbPrepare: 0, kvGet: 0, kvPut: 0 };
    const req = buildApp(
      {
        DB: fakeDB({
          videoExists: true,
          hasLikeForUser: true,
          countAfterToggle: 0,
          insertCalls: inserts,
          deleteCalls: deletes,
        }),
        CACHE: fakeCache({ initial: { 'likes:v1:v1': '99' }, counters }),
      },
      { id: 'user-1' },
    );
    const res = await req('/api/videos/v1/like', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ likes: 0, liked: false });
    expect(inserts.current).toBe(0);
    expect(deletes.current).toBe(1);
    expect(counters.kvPut).toBe(1);
  });
});
