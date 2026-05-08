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

// ALO-121: resume-on-disconnect endpoint surfaces server-known chunks.
describe('upload status endpoint', () => {
  function envWithSessions(store: Record<string, string>): VideoRoutesEnv {
    const sessions = {
      async get(key: string) {
        return store[key] ?? null;
      },
      async put() {},
      async delete() {},
    } as unknown as KVNamespace;
    return {
      DB: {} as unknown as D1Database,
      VIDEOS: {} as unknown as R2Bucket,
      CACHE: {} as unknown as KVNamespace,
      SESSIONS: sessions,
      VIDEO_ENCODING: { send: async () => {} } as unknown as Queue,
    };
  }

  it('returns 401 when unauthenticated', async () => {
    const fetcher = mountWithUser(envWithSessions({}), null);
    const res = await fetcher('/api/videos/upload/abc/status');
    expect(res.status).toBe(401);
  });

  it('returns 404 when no session exists for the user/uploadId pair', async () => {
    const fetcher = mountWithUser(envWithSessions({}), {
      id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/missing/status');
    expect(res.status).toBe(404);
  });

  it('reports received chunk indexes (0-based) from stored parts', async () => {
    const base = 'upload:u1:abc';
    const store: Record<string, string> = {
      [`${base}:mpid`]: 'mpid-1',
      [`${base}:meta`]: JSON.stringify({
        videoId: 'v1', r2Key: 'u1/v1/clip.mp4', title: 't', description: 'd', chunkCount: 3,
      }),
      [`${base}:parts`]: JSON.stringify({
        '1': { etag: 'e1', size: 10 },
        '3': { etag: 'e3', size: 7 },
      }),
    };
    const fetcher = mountWithUser(envWithSessions(store), {
      id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/abc/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadId: string; chunkCount: number; received: number[]; bytesReceived: number;
    };
    expect(body.uploadId).toBe('abc');
    expect(body.chunkCount).toBe(3);
    expect(body.received).toEqual([0, 2]);
    expect(body.bytesReceived).toBe(17);
  });

  it('scopes upload sessions per user (cannot read another user\'s upload)', async () => {
    const base = 'upload:other:abc';
    const store: Record<string, string> = {
      [`${base}:mpid`]: 'mpid-1',
      [`${base}:meta`]: JSON.stringify({
        videoId: 'v1', r2Key: 'other/v1/clip.mp4', title: 't', description: 'd', chunkCount: 1,
      }),
    };
    const fetcher = mountWithUser(envWithSessions(store), {
      id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/abc/status');
    expect(res.status).toBe(404);
  });
});
