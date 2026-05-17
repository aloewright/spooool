import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { dedupKey } from './analytics';
import {
  VIDEO_META_CACHE_TTL_SECONDS,
  videoMetaCacheKey,
} from './video-meta-cache';
import { videoRoutes, type VideoRoutesEnv } from './videos';

describe('video metadata KV cache (ALO-201)', () => {
  it('namespaces keys under video:v1:<id> so other ids cant collide', () => {
    expect(videoMetaCacheKey('abc')).toBe('video:v1:abc');
    expect(videoMetaCacheKey('abc')).not.toBe(videoMetaCacheKey('abcd'));
  });

  it('encodes the id as-is — D1 ids are URL-safe UUIDs already', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(videoMetaCacheKey(uuid)).toBe(`video:v1:${uuid}`);
  });

  it('TTL is short enough that webhook-driven status flips converge in <2 minutes', () => {
    // Webhook can transition encoding -> ready. We only cache rows where
    // status === 'ready', so the only stale-window the user sees is when
    // a separately-fetched aspect of the row changes. The 60s TTL bounds
    // that window; tighten only if we add cache for transient states.
    expect(VIDEO_META_CACHE_TTL_SECONDS).toBeLessThanOrEqual(120);
    expect(VIDEO_META_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(30);
  });
});

// --- Fakes ---------------------------------------------------------------
//
// Same fake-D1 + fake-KV pattern as likes.test.ts (ALO-404) so this suite
// stays dependency-free (no miniflare, no real D1). We only need to model
// the GET /api/videos/:id read path — the upload/delete paths are covered
// elsewhere.

type Counters = {
  metaSelects: number;
  kvPut: number;
  kvPuts: { key: string; value: string; ttl: number | undefined }[];
};

const META_SELECT_RE = /SELECT v\.id, v\.user_id, v\.title.*FROM videos v/s;

type VideoRow = {
  id: string;
  user_id: string;
  title: string;
  description: string;
  r2_key: string;
  stream_video_id: string | null;
  status: string;
  view_count: number;
  created_at: string;
  updated_at: string;
  hidden_at: string | null;
  dmca_status: string | null;
  channel_name: string | null;
  channel_username: string | null;
};

function makeRow(overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 'vid-1',
    user_id: 'creator-1',
    title: 'Test video',
    description: 'A test',
    r2_key: 'creator-1/vid-1/file.mp4',
    stream_video_id: null,
    status: 'ready',
    view_count: 4,
    created_at: '2026-05-17 12:00:00',
    updated_at: '2026-05-17 12:00:00',
    hidden_at: null,
    dmca_status: null,
    channel_name: 'Creator',
    channel_username: 'creator',
    ...overrides,
  };
}

function fakeDB(opts: { row: VideoRow | null; counters: Counters }): D1Database {
  const { row, counters } = opts;
  const prepare = (sql: string) => {
    const stmt = {
      bind: (..._values: unknown[]) => stmt,
      first: async () => {
        // Count on first() rather than prepare() — D1's prepare is lazy and
        // the metric we actually care about is "did the route execute a
        // meta SELECT". In practice every prepare in the route is followed
        // by an immediate first/all/run, so the count is the same; this
        // form is just self-documenting.
        if (META_SELECT_RE.test(sql)) {
          counters.metaSelects += 1;
          return row;
        }
        return null;
      },
      all: async () => ({ results: [] }),
      // UPDATE videos / INSERT INTO views from the view-counting path. We
      // don't care about their effects for these tests — they should never
      // fire because we pre-seed the dedup KV entry.
      run: async () => ({ success: true }),
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

function fakeCache(opts: {
  initial?: Record<string, string>;
  counters: Counters;
}): KVNamespace {
  const store: Record<string, string> = { ...(opts.initial ?? {}) };
  return {
    get: async (key: string, type?: 'json' | 'text') => {
      const raw = store[key] ?? null;
      if (raw === null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => {
      opts.counters.kvPut += 1;
      opts.counters.kvPuts.push({
        key,
        value,
        ttl: options?.expirationTtl,
      });
      store[key] = String(value);
    },
  } as unknown as KVNamespace;
}

type SessionUser = { id: string } | null;

// Pre-seed the dedup KV entry for an anonymous viewer with a known session id
// so `shouldCountView` returns false and the view-counting D1 writes never
// fire. That makes the meta-read SELECT the only call worth asserting on.
const ANON_SID = 'anon-sid-1';
const COOKIE_HEADER = `spool_view_sid=${ANON_SID}`;
const dedup = (videoId: string) => dedupKey(videoId, `s:${ANON_SID}`);

function newCounters(): Counters {
  return { metaSelects: 0, kvPut: 0, kvPuts: [] };
}

function buildApp(env: VideoRoutesEnv, user: SessionUser = null) {
  const app = new Hono<{ Bindings: VideoRoutesEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', videoRoutes);
  return (path: string, init?: RequestInit) =>
    app.request(
      path,
      { headers: { cookie: COOKIE_HEADER }, ...init },
      env,
    );
}

function envWith(args: {
  row: VideoRow | null;
  cacheInitial?: Record<string, string>;
  counters: Counters;
}): VideoRoutesEnv {
  return {
    DB: fakeDB({ row: args.row, counters: args.counters }),
    CACHE: fakeCache({ initial: args.cacheInitial, counters: args.counters }),
    SESSIONS: fakeCache({ counters: newCounters() }), // unused on this path
    VIDEOS: undefined as unknown as R2Bucket,
    VIDEO_ENCODING: undefined as unknown as Queue,
  };
}

// --- GET /api/videos/:id consumer integration ----------------------------

describe('GET /api/videos/:id — KV metadata cache (ALO-406)', () => {
  it('cache miss reads from D1 then writes the row back to KV with the 60s TTL', async () => {
    const counters = newCounters();
    const row = makeRow({ id: 'vid-1' });
    const env = envWith({
      row,
      cacheInitial: { [dedup('vid-1')]: '1' },
      counters,
    });
    const req = buildApp(env);
    const res = await req('/api/videos/vid-1');

    expect(res.status).toBe(200);
    expect(res.headers.get('x-spooool-cache')).toBe('miss');
    expect(counters.metaSelects).toBe(1);

    const cachePut = counters.kvPuts.find((p) => p.key === videoMetaCacheKey('vid-1'));
    expect(cachePut, 'meta row should be written to KV after a miss').toBeDefined();
    expect(cachePut!.ttl).toBe(VIDEO_META_CACHE_TTL_SECONDS);
    // The cached value should be the row as JSON — what the next reader sees.
    expect(JSON.parse(cachePut!.value)).toMatchObject({
      id: 'vid-1',
      user_id: 'creator-1',
      status: 'ready',
    });
  });

  it('cache hit serves from KV and never prepares the meta SELECT', async () => {
    const counters = newCounters();
    const cached = makeRow({ id: 'vid-1', view_count: 99 });
    const env = envWith({
      row: null, // D1 should never be touched for the meta read
      cacheInitial: {
        [videoMetaCacheKey('vid-1')]: JSON.stringify(cached),
        [dedup('vid-1')]: '1',
      },
      counters,
    });
    const req = buildApp(env);
    const res = await req('/api/videos/vid-1');

    expect(res.status).toBe(200);
    expect(res.headers.get('x-spooool-cache')).toBe('hit');
    expect(counters.metaSelects).toBe(0);
    // No re-write of the cached row.
    const cachePut = counters.kvPuts.find((p) => p.key === videoMetaCacheKey('vid-1'));
    expect(cachePut).toBeUndefined();
    const body = (await res.json()) as { view_count: number };
    expect(body.view_count).toBe(99);
  });

  it('does NOT cache a row whose status is "encoding" (transient state)', async () => {
    // Regression guard: the inline `status === 'ready'` check in
    // src/workers/videos.ts is what keeps a still-encoding row from being
    // pinned in KV for 60 seconds. If somebody loosens that condition we
    // need this test to fail.
    const counters = newCounters();
    const row = makeRow({ id: 'enc-1', status: 'encoding' });
    const env = envWith({
      row,
      cacheInitial: { [dedup('enc-1')]: '1' },
      counters,
    });
    const req = buildApp(env);
    const res = await req('/api/videos/enc-1');

    expect(res.status).toBe(200);
    expect(counters.metaSelects).toBe(1);
    const cachePut = counters.kvPuts.find((p) => p.key === videoMetaCacheKey('enc-1'));
    expect(cachePut, 'transient encoding row must never be cached').toBeUndefined();
  });

  it('does NOT cache a hidden row even when status is "ready"', async () => {
    // Same protection from the other angle: a viewable-by-owner-only video
    // shouldn't bleed into the shared KV namespace where another viewer
    // could observe it for the duration of the TTL.
    const counters = newCounters();
    const row = makeRow({ id: 'hid-1', hidden_at: '2026-05-17 12:00:00' });
    const env = envWith({
      row,
      cacheInitial: { [dedup('hid-1')]: '1' },
      counters,
    });
    const req = buildApp(env, { id: 'creator-1' } as SessionUser);
    const res = await req('/api/videos/hid-1');

    expect(res.status).toBe(200);
    const cachePut = counters.kvPuts.find((p) => p.key === videoMetaCacheKey('hid-1'));
    expect(cachePut).toBeUndefined();
  });

  it('does NOT cache a DMCA-disabled row (would short-circuit to 451)', async () => {
    const counters = newCounters();
    const row = makeRow({ id: 'dmca-1', dmca_status: 'disabled' });
    const env = envWith({
      row,
      cacheInitial: { [dedup('dmca-1')]: '1' },
      counters,
    });
    const req = buildApp(env);
    const res = await req('/api/videos/dmca-1');

    expect(res.status).toBe(451);
    const cachePut = counters.kvPuts.find((p) => p.key === videoMetaCacheKey('dmca-1'));
    expect(cachePut).toBeUndefined();
  });

  it('cache hit honours the existing 451 short-circuit when status flips post-cache', async () => {
    // Belt-and-braces: even if a 'disabled' row were somehow cached (it
    // shouldn't be — see the prior test), the route still emits 451 on the
    // next read instead of leaking it as a 200 to viewers.
    const counters = newCounters();
    const cached = makeRow({ id: 'dmca-2', dmca_status: 'disabled' });
    const env = envWith({
      row: null,
      cacheInitial: {
        [videoMetaCacheKey('dmca-2')]: JSON.stringify(cached),
        [dedup('dmca-2')]: '1',
      },
      counters,
    });
    const req = buildApp(env);
    const res = await req('/api/videos/dmca-2');
    expect(res.status).toBe(451);
    expect(counters.metaSelects).toBe(0);
  });

  it('returns 404 and does not cache when the row is missing entirely', async () => {
    const counters = newCounters();
    const env = envWith({
      row: null,
      cacheInitial: { [dedup('missing')]: '1' },
      counters,
    });
    const req = buildApp(env);
    const res = await req('/api/videos/missing');

    expect(res.status).toBe(404);
    expect(counters.metaSelects).toBe(1);
    const cachePut = counters.kvPuts.find((p) => p.key === videoMetaCacheKey('missing'));
    expect(cachePut).toBeUndefined();
  });
});
