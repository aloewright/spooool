import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { thumbnailRoutes, type ThumbnailEnv, type ThumbnailVariables } from './thumbnails';

interface VideoRow {
  id: string;
  user_id: string;
  thumbnail_candidates: string | null;
  thumbnail_url: string | null;
  deleted_at: number | null;
}

interface Store {
  videos: VideoRow[];
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

function fakeDB(store: Store): D1Database {
  const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
  function prepare(sql: string): PreparedStmt {
    const q = flat(sql);
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values) {
        args = values;
        return stmt;
      },
      async first<T>() {
        if (q.startsWith('SELECT id, user_id, thumbnail_candidates FROM videos')) {
          const [id] = args as [string];
          const v = store.videos.find((x) => x.id === id && x.deleted_at === null);
          if (!v) return null;
          return {
            id: v.id,
            user_id: v.user_id,
            thumbnail_candidates: v.thumbnail_candidates,
          } as unknown as T;
        }
        if (q.startsWith('SELECT id, user_id FROM videos')) {
          const [id] = args as [string];
          const v = store.videos.find((x) => x.id === id && x.deleted_at === null);
          if (!v) return null;
          return { id: v.id, user_id: v.user_id } as unknown as T;
        }
        throw new Error(`unexpected first query: ${q}`);
      },
      async run() {
        if (q.startsWith('UPDATE videos SET thumbnail_url = ?')) {
          const [url, id] = args as [string, string];
          const v = store.videos.find((x) => x.id === id);
          if (v) v.thumbnail_url = url;
          return { success: true };
        }
        throw new Error(`unexpected run query: ${q}`);
      },
      async all<_T>() {
        throw new Error(`unexpected all query: ${q}`);
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

function fakeR2() {
  const storage = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const binding = {
    async put(
      key: string,
      stream: ReadableStream,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      storage.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const obj = storage.get(key);
      if (!obj) return null;
      return {
        body: obj.bytes,
        httpMetadata: { contentType: obj.contentType },
      };
    },
  } as unknown as R2Bucket;
  return { binding, storage };
}

function buildApp(user: { id: string } | null) {
  const app = new Hono<{ Bindings: ThumbnailEnv; Variables: ThumbnailVariables }>();
  app.use('*', async (c, next) => {
    c.set('user', user as ThumbnailVariables['user']);
    await next();
  });
  app.route('/', thumbnailRoutes);
  return app;
}

describe('thumbnailRoutes integration', () => {
  let store: Store;
  let r2: ReturnType<typeof fakeR2>;
  let env: ThumbnailEnv;

  beforeEach(() => {
    store = {
      videos: [
        {
          id: 'v1',
          user_id: 'u1',
          thumbnail_candidates: JSON.stringify([
            'https://videodelivery.net/abc/thumbnails/thumbnail.jpg?time=10s',
            'https://videodelivery.net/abc/thumbnails/thumbnail.jpg?time=50s',
          ]),
          thumbnail_url: null,
          deleted_at: null,
        },
        {
          id: 'v2',
          user_id: 'u2',
          thumbnail_candidates: null,
          thumbnail_url: null,
          deleted_at: null,
        },
      ],
    };
    r2 = fakeR2();
    env = { DB: fakeDB(store), VIDEOS: r2.binding };
  });

  describe('PUT /api/videos/:id/thumbnail', () => {
    it('returns 401 without a session', async () => {
      const app = buildApp(null);
      const res = await app.request(
        '/api/videos/v1/thumbnail',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://x' }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });

    it('returns 404 for missing/deleted videos', async () => {
      const app = buildApp({ id: 'u1' });
      const res = await app.request(
        '/api/videos/missing/thumbnail',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: 'https://videodelivery.net/abc/thumbnails/thumbnail.jpg?time=10s',
          }),
        },
        env,
      );
      expect(res.status).toBe(404);
    });

    it('returns 403 when the user does not own the video', async () => {
      const app = buildApp({ id: 'u1' });
      const res = await app.request(
        '/api/videos/v2/thumbnail',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://x' }),
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it('rejects URLs that are neither candidates nor owned uploads', async () => {
      const app = buildApp({ id: 'u1' });
      const res = await app.request(
        '/api/videos/v1/thumbnail',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://evil.example.com/x.jpg' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('accepts a candidate URL and persists it', async () => {
      const app = buildApp({ id: 'u1' });
      const candidate = 'https://videodelivery.net/abc/thumbnails/thumbnail.jpg?time=10s';
      const res = await app.request(
        '/api/videos/v1/thumbnail',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: candidate }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(store.videos[0].thumbnail_url).toBe(candidate);
    });

    it('accepts an owned R2 upload URL', async () => {
      const app = buildApp({ id: 'u1' });
      const owned = 'https://example.com/api/thumbnails/u1/v1/abc.jpg';
      const res = await app.request(
        '/api/videos/v1/thumbnail',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: owned }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(store.videos[0].thumbnail_url).toBe(owned);
    });
  });

  describe('POST /api/videos/:id/thumbnail (upload)', () => {
    function makeForm(type: string, size = 64, name = 'thumb.png'): FormData {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(size)], name, { type }));
      return form;
    }

    it('uploads a file, persists URL, and stores under thumbnails/<user>/<video>/', async () => {
      const app = buildApp({ id: 'u1' });
      const res = await app.request(
        'http://example.com/api/videos/v1/thumbnail',
        { method: 'POST', body: makeForm('image/png') },
        env,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { thumbnail_url: string; id: string };
      expect(body.id).toBe('v1');
      const path = new URL(body.thumbnail_url).pathname;
      expect(path).toMatch(/^\/api\/thumbnails\/u1\/v1\/[0-9a-f-]+\.png$/);
      expect(store.videos[0].thumbnail_url).toBe(body.thumbnail_url);
      const r2Key = [...r2.storage.keys()][0];
      expect(r2Key.startsWith('thumbnails/u1/v1/')).toBe(true);
    });

    it('rejects non-image content types', async () => {
      const app = buildApp({ id: 'u1' });
      const res = await app.request(
        'http://example.com/api/videos/v1/thumbnail',
        { method: 'POST', body: makeForm('application/pdf') },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('rejects oversize uploads', async () => {
      const app = buildApp({ id: 'u1' });
      const big = 5 * 1024 * 1024 + 1;
      const res = await app.request(
        'http://example.com/api/videos/v1/thumbnail',
        { method: 'POST', body: makeForm('image/png', big) },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 403 when the user does not own the video', async () => {
      const app = buildApp({ id: 'u1' });
      const res = await app.request(
        'http://example.com/api/videos/v2/thumbnail',
        { method: 'POST', body: makeForm('image/png') },
        env,
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/thumbnails/:userId/:videoId/:objectName', () => {
    it('serves uploaded bytes with caching headers', async () => {
      const app = buildApp({ id: 'u1' });
      const upload = await app.request(
        'http://example.com/api/videos/v1/thumbnail',
        {
          method: 'POST',
          body: (() => {
            const f = new FormData();
            f.set('file', new File([new Uint8Array([1, 2, 3, 4])], 't.webp', { type: 'image/webp' }));
            return f;
          })(),
        },
        env,
      );
      const { thumbnail_url } = (await upload.json()) as { thumbnail_url: string };
      const res = await app.request(thumbnail_url, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toContain('immutable');
    });

    it('rejects path-traversal-shaped object names', async () => {
      const app = buildApp(null);
      const res = await app.request(
        'http://example.com/api/thumbnails/u1/v1/..%2Fevil',
        {},
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when the R2 object is missing', async () => {
      const app = buildApp(null);
      const res = await app.request(
        'http://example.com/api/thumbnails/u1/v1/nope.png',
        {},
        env,
      );
      expect(res.status).toBe(404);
    });
  });
});
