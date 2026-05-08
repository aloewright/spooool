import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { videoRoutes, type VideoRoutesEnv } from './videos';

interface QuotaState {
  used: number;
  quota: number;
}

function fakeEnv(quota: QuotaState): VideoRoutesEnv {
  // Minimal D1 stub — only the storage-quota SELECTs are exercised by the
  // tests below. The 413 path returns before any other DB / R2 / KV /
  // queue work, so we don't have to fake those bindings.
  const db = {
    prepare(sql: string) {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      let bound: unknown[] = [];
      const api = {
        bind(...v: unknown[]) {
          bound = v;
          return api;
        },
        async first() {
          if (trimmed.startsWith('SELECT COALESCE(SUM(bytes)')) {
            return { used: quota.used } as never;
          }
          if (trimmed.startsWith('SELECT storage_bytes_quota AS quota FROM user')) {
            return { quota: quota.quota } as never;
          }
          return null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
      void bound;
      return api;
    },
  } as unknown as D1Database;
  return {
    DB: db,
    VIDEOS: { put: async () => {} } as unknown as R2Bucket,
    CACHE: {} as unknown as KVNamespace,
    SESSIONS: {} as unknown as KVNamespace,
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue,
  };
}

type TestUser = { id: string; email: string; name: string; emailVerified?: boolean } | null;

function mountWithUser(env: VideoRoutesEnv, user: TestUser) {
  const app = new Hono<{ Bindings: VideoRoutesEnv; Variables: { user: TestUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', videoRoutes);
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://t${path}`, init), env as never);
}

// ALO-128: gate uploads on email verification before any other work.
describe('upload email-verification gate', () => {
  it('returns 403 with code=email_unverified when emailVerified=false', async () => {
    const fetcher = mountWithUser(
      fakeEnv({ used: 0, quota: 1024 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: false },
    );
    const fd = new FormData();
    fd.set('title', 'hi');
    fd.set('description', '');
    fd.set('file', new Blob([new Uint8Array(8)], { type: 'video/mp4' }), 'clip.mp4');
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('email_unverified');
  });

  it('returns 401 when no session', async () => {
    const fetcher = mountWithUser(fakeEnv({ used: 0, quota: 1024 }), null);
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(401);
  });

  it('does not gate when emailVerified=true (passes through to validation)', async () => {
    const fetcher = mountWithUser(
      fakeEnv({ used: 0, quota: 1024 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true },
    );
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: new FormData() });
    // No file attached → 400 at validation, NOT 403 from the gate.
    expect(res.status).toBe(400);
  });

  it('treats undefined emailVerified as verified (legacy callers)', async () => {
    const fetcher = mountWithUser(
      fakeEnv({ used: 0, quota: 1024 }),
      { id: 'u1', email: 'a@b.com', name: 'A' },
    );
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });
});

// ALO-139: quota precheck at chunk-0.
describe('upload storage-quota gate', () => {
  it('rejects with 413 + code=storage_quota_exceeded when chunk-0 would overflow', async () => {
    const fetcher = mountWithUser(
      fakeEnv({ used: 900, quota: 1000 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true },
    );
    const fd = new FormData();
    fd.set('title', 'hi');
    fd.set('description', '');
    // 200 bytes incoming, 100 bytes remaining → over quota.
    fd.set('file', new Blob([new Uint8Array(200)], { type: 'video/mp4' }), 'clip.mp4');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; storage: { used: number; quota: number; remaining: number } };
    expect(body.code).toBe('storage_quota_exceeded');
    expect(body.storage).toEqual({ used: 900, quota: 1000, remaining: 100 });
  });

  it('lets the upload through when there is room', async () => {
    const fetcher = mountWithUser(
      fakeEnv({ used: 0, quota: 1024 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true },
    );
    const fd = new FormData();
    fd.set('title', 'hi');
    fd.set('description', '');
    fd.set('file', new Blob([new Uint8Array(5)], { type: 'video/mp4' }), 'clip.mp4');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
  });
});

// ALO-134: resume-on-disconnect — clients query the status endpoint to learn
// which chunks the server already has, then re-POST starting at nextChunkIndex.
describe('upload resume status (ALO-134)', () => {
  function fakeEnvWithKv(store: Map<string, string>): VideoRoutesEnv {
    const sessions = {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    } as unknown as KVNamespace;
    return {
      DB: {} as unknown as D1Database,
      VIDEOS: {} as unknown as R2Bucket,
      CACHE: {} as unknown as KVNamespace,
      SESSIONS: sessions,
      VIDEO_ENCODING: {} as unknown as Queue,
    };
  }

  it('returns 404 when no session exists for the uploadId', async () => {
    const env = fakeEnvWithKv(new Map());
    const fetcher = mountWithUser(env, { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true });
    const res = await fetcher('/api/videos/upload/missing-id/status');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('upload_not_found');
  });

  it('returns the manifest and nextChunkIndex for an in-progress upload', async () => {
    const store = new Map<string, string>();
    const baseKvKey = 'upload:u1:abc';
    store.set(
      `${baseKvKey}:meta`,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'u1/v1/clip.mp4',
        title: 'hi',
        description: '',
        chunkCount: 4,
      }),
    );
    // Parts 1 and 3 received → chunkIndex 0 and 2 → next missing is 1.
    store.set(
      `${baseKvKey}:parts`,
      JSON.stringify({
        '1': { etag: 'e1', size: 100 },
        '3': { etag: 'e3', size: 100 },
      }),
    );
    const env = fakeEnvWithKv(store);
    const fetcher = mountWithUser(env, { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true });
    const res = await fetcher('/api/videos/upload/abc/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chunkCount: number;
      receivedChunks: number[];
      receivedBytes: number;
      nextChunkIndex: number | null;
      complete: boolean;
    };
    expect(body.chunkCount).toBe(4);
    expect(body.receivedChunks).toEqual([0, 2]);
    expect(body.receivedBytes).toBe(200);
    expect(body.nextChunkIndex).toBe(1);
    expect(body.complete).toBe(false);
  });

  it('signals complete=true when every chunk is present', async () => {
    const store = new Map<string, string>();
    const baseKvKey = 'upload:u1:done';
    store.set(
      `${baseKvKey}:meta`,
      JSON.stringify({ videoId: 'v1', r2Key: 'u1/v1/c.mp4', title: 't', description: '', chunkCount: 2 }),
    );
    store.set(
      `${baseKvKey}:parts`,
      JSON.stringify({
        '1': { etag: 'e1', size: 50 },
        '2': { etag: 'e2', size: 50 },
      }),
    );
    const env = fakeEnvWithKv(store);
    const fetcher = mountWithUser(env, { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true });
    const res = await fetcher('/api/videos/upload/done/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextChunkIndex: number | null; complete: boolean };
    expect(body.complete).toBe(true);
    expect(body.nextChunkIndex).toBeNull();
  });

  it('rejects unauthenticated callers', async () => {
    const fetcher = mountWithUser(fakeEnvWithKv(new Map()), null);
    const res = await fetcher('/api/videos/upload/anything/status');
    expect(res.status).toBe(401);
  });
});
