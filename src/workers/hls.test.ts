import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  contentTypeForHlsAsset,
  hlsRoutes,
  resolveHlsKey,
  type HlsServeEnv,
} from './hls';

interface FakeR2Object {
  key: string;
  body: Uint8Array;
  contentType?: string;
}

interface FakeRow {
  id: string;
  user_id: string;
  playback_hls_path: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
  deleted_at: string | null;
}

function makeEnv(rows: FakeRow[], objects: FakeR2Object[]): HlsServeEnv {
  const objectMap = new Map(objects.map((o) => [o.key, o]));
  const db = {
    prepare(_query: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first() {
          const [videoId] = bound as [string];
          const row = rows.find((r) => r.id === videoId && r.deleted_at === null);
          return row ?? null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  const r2 = {
    async get(key: string) {
      const obj = objectMap.get(key);
      if (!obj) return null;
      return {
        body: new Response(obj.body as BodyInit).body,
        size: obj.body.byteLength,
        httpMetadata: { contentType: obj.contentType ?? 'application/octet-stream' },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const obj = objectMap.get(key);
      if (!obj) return null;
      return {
        size: obj.body.byteLength,
        httpMetadata: { contentType: obj.contentType ?? 'application/octet-stream' },
      } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
  return { DB: db, VIDEOS: r2 };
}

type SessionUser = { id: string } | null;

function mountWithUser(env: HlsServeEnv, user: SessionUser) {
  const app = new Hono<{ Bindings: HlsServeEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', hlsRoutes);
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://t${path}`, init), env as never);
}

describe('contentTypeForHlsAsset', () => {
  it('maps .m3u8 → mpegurl', () => {
    expect(contentTypeForHlsAsset('master.m3u8', null)).toBe('application/vnd.apple.mpegurl');
  });

  it('maps .ts → mp2t', () => {
    expect(contentTypeForHlsAsset('seg-001.ts', null)).toBe('video/mp2t');
  });

  it('falls back to the supplied default for unknown extensions', () => {
    expect(contentTypeForHlsAsset('hello.bin', 'application/octet-stream')).toBe(
      'application/octet-stream',
    );
  });
});

describe('resolveHlsKey', () => {
  it('joins the master playlist key and a sub-path', () => {
    expect(resolveHlsKey('u/v1/hls/master.m3u8', '720p/playlist.m3u8')).toBe(
      'u/v1/hls/720p/playlist.m3u8',
    );
  });

  it('returns the key for the master playlist itself', () => {
    expect(resolveHlsKey('u/v1/hls/master.m3u8', 'master.m3u8')).toBe('u/v1/hls/master.m3u8');
  });

  it('rejects path traversal', () => {
    expect(resolveHlsKey('u/v1/hls/master.m3u8', '../other/secret.m3u8')).toBeNull();
    expect(resolveHlsKey('u/v1/hls/master.m3u8', './master.m3u8')).toBeNull();
  });

  it('rejects an empty sub-path', () => {
    expect(resolveHlsKey('u/v1/hls/master.m3u8', '')).toBeNull();
  });
});

describe('GET /api/videos/:id/hls/*', () => {
  it('serves the master playlist with the right content-type', async () => {
    const env = makeEnv(
      [
        {
          id: 'v1',
          user_id: 'u1',
          playback_hls_path: 'u1/v1/hls/master.m3u8',
          hidden_at: null,
          dmca_status: null,
          deleted_at: null,
        },
      ],
      [
        {
          key: 'u1/v1/hls/master.m3u8',
          body: new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n'),
        },
      ],
    );
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/v1/hls/master.m3u8');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(await res.text()).toContain('#EXTM3U');
  });

  it('serves a variant segment', async () => {
    const env = makeEnv(
      [
        {
          id: 'v1',
          user_id: 'u1',
          playback_hls_path: 'u1/v1/hls/master.m3u8',
          hidden_at: null,
          dmca_status: null,
          deleted_at: null,
        },
      ],
      [
        {
          key: 'u1/v1/hls/720p/seg-1.ts',
          body: new Uint8Array([0x47, 0x00, 0x00, 0x00]),
        },
      ],
    );
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/v1/hls/720p/seg-1.ts');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x47);
  });

  it('404s when the video has no HLS output yet', async () => {
    const env = makeEnv(
      [
        {
          id: 'v1',
          user_id: 'u1',
          playback_hls_path: null,
          hidden_at: null,
          dmca_status: null,
          deleted_at: null,
        },
      ],
      [],
    );
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/v1/hls/master.m3u8');
    expect(res.status).toBe(404);
  });

  it('404s when the video does not exist', async () => {
    const env = makeEnv([], []);
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/missing/hls/master.m3u8');
    expect(res.status).toBe(404);
  });

  it('returns 451 for DMCA-disabled videos', async () => {
    const env = makeEnv(
      [
        {
          id: 'v1',
          user_id: 'u1',
          playback_hls_path: 'u1/v1/hls/master.m3u8',
          hidden_at: null,
          dmca_status: 'disabled',
          deleted_at: null,
        },
      ],
      [],
    );
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/v1/hls/master.m3u8');
    expect(res.status).toBe(451);
  });

  it('hides hidden videos from non-owners but serves them to the owner', async () => {
    const env = makeEnv(
      [
        {
          id: 'v1',
          user_id: 'owner',
          playback_hls_path: 'owner/v1/hls/master.m3u8',
          hidden_at: '2026-01-01',
          dmca_status: null,
          deleted_at: null,
        },
      ],
      [
        {
          key: 'owner/v1/hls/master.m3u8',
          body: new TextEncoder().encode('#EXTM3U\n'),
        },
      ],
    );

    const stranger = mountWithUser(env, { id: 'someone-else' });
    const strangerRes = await stranger('/api/videos/v1/hls/master.m3u8');
    expect(strangerRes.status).toBe(404);

    const owner = mountWithUser(env, { id: 'owner' });
    const ownerRes = await owner('/api/videos/v1/hls/master.m3u8');
    expect(ownerRes.status).toBe(200);
  });

  it('caches manifests short and segments long', async () => {
    const env = makeEnv(
      [
        {
          id: 'v1',
          user_id: 'u1',
          playback_hls_path: 'u1/v1/hls/master.m3u8',
          hidden_at: null,
          dmca_status: null,
          deleted_at: null,
        },
      ],
      [
        {
          key: 'u1/v1/hls/master.m3u8',
          body: new TextEncoder().encode('#EXTM3U\n'),
        },
        {
          key: 'u1/v1/hls/720p/seg-1.ts',
          body: new Uint8Array([0x47]),
        },
      ],
    );
    const fetcher = mountWithUser(env, null);
    const manifestRes = await fetcher('/api/videos/v1/hls/master.m3u8');
    expect(manifestRes.headers.get('cache-control')).toMatch(/max-age=60/);
    const segmentRes = await fetcher('/api/videos/v1/hls/720p/seg-1.ts');
    expect(segmentRes.headers.get('cache-control')).toMatch(/immutable/);
  });
});
