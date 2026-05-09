import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { videoRoutes, type VideoRoutesEnv } from './videos';
import { uploadSessionKeys } from './upload-session';

interface QuotaState {
  used: number;
  quota: number;
}

class FakeKV {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  has(key: string): boolean {
    return this.store.has(key);
  }
}

function fakeEnv(
  quota: QuotaState,
  overrides: Partial<VideoRoutesEnv> = {},
): VideoRoutesEnv {
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
    ...overrides,
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

// ALO-121: resume status endpoint. The frontend uses it to learn which
// chunks are already on the server before retrying so a 1GB upload
// resumed after a disconnect doesn't re-send any megabyte twice.
describe('GET /api/videos/upload/:uploadId/status', () => {
  it('401 when no session', async () => {
    const fetcher = mountWithUser(fakeEnv({ used: 0, quota: 1024 }), null);
    const res = await fetcher('/api/videos/upload/up-1/status');
    expect(res.status).toBe(401);
  });

  it('404 when the upload session is missing or expired', async () => {
    const sessions = new FakeKV();
    const env = fakeEnv(
      { used: 0, quota: 1024 },
      { SESSIONS: sessions as unknown as KVNamespace },
    );
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/never-existed/status');
    expect(res.status).toBe(404);
  });

  it('returns chunkCount + uploadedChunks for the caller’s own session', async () => {
    const sessions = new FakeKV();
    const keys = uploadSessionKeys('u1', 'up-resume');
    await sessions.put(keys.mpid, 'mpid-xyz');
    await sessions.put(
      keys.meta,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'u1/v1/clip.mp4',
        title: 'My clip',
        description: 'd',
        chunkCount: 5,
        fileName: 'clip.mp4',
        fileSize: 12345,
      }),
    );
    await sessions.put(
      keys.parts,
      JSON.stringify({
        '1': { etag: 'e1', size: 10 },
        '3': { etag: 'e3', size: 10 },
      }),
    );
    const env = fakeEnv(
      { used: 0, quota: 1024 },
      { SESSIONS: sessions as unknown as KVNamespace },
    );
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });

    const res = await fetcher('/api/videos/upload/up-resume/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadId: string;
      chunkCount: number;
      uploadedChunks: number[];
      fileName: string | null;
      fileSize: number | null;
      title: string;
    };
    expect(body.uploadId).toBe('up-resume');
    expect(body.chunkCount).toBe(5);
    expect(body.uploadedChunks).toEqual([0, 2]);
    expect(body.fileName).toBe('clip.mp4');
    expect(body.fileSize).toBe(12345);
    expect(body.title).toBe('My clip');
  });

  it('cannot read another user’s upload (different KV namespace path)', async () => {
    const sessions = new FakeKV();
    // Session belongs to u2.
    const keys = uploadSessionKeys('u2', 'up-private');
    await sessions.put(keys.mpid, 'mpid');
    await sessions.put(
      keys.meta,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'u2/v1/clip.mp4',
        title: 't',
        description: '',
        chunkCount: 2,
      }),
    );
    const env = fakeEnv(
      { used: 0, quota: 1024 },
      { SESSIONS: sessions as unknown as KVNamespace },
    );
    // ...but u1 calls the endpoint.
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/up-private/status');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/videos/upload/:uploadId', () => {
  it('401 when no session', async () => {
    const fetcher = mountWithUser(fakeEnv({ used: 0, quota: 1024 }), null);
    const res = await fetcher('/api/videos/upload/up-1', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('clears the KV session and aborts the R2 multipart', async () => {
    const sessions = new FakeKV();
    const keys = uploadSessionKeys('u1', 'up-cancel');
    await sessions.put(keys.mpid, 'mpid-xyz');
    await sessions.put(
      keys.meta,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'u1/v1/clip.mp4',
        title: 't',
        description: '',
        chunkCount: 3,
      }),
    );
    await sessions.put(keys.parts, JSON.stringify({ '1': { etag: 'e1', size: 1 } }));

    const aborts: Array<{ key: string; uploadId: string }> = [];
    const r2 = {
      put: async () => {},
      resumeMultipartUpload: (key: string, mpid: string) => ({
        async abort() {
          aborts.push({ key, uploadId: mpid });
        },
      }),
    } as unknown as R2Bucket;

    const env = fakeEnv(
      { used: 0, quota: 1024 },
      { SESSIONS: sessions as unknown as KVNamespace, VIDEOS: r2 },
    );
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });

    const res = await fetcher('/api/videos/upload/up-cancel', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(aborts).toEqual([{ key: 'u1/v1/clip.mp4', uploadId: 'mpid-xyz' }]);
    expect(sessions.has(keys.mpid)).toBe(false);
    expect(sessions.has(keys.meta)).toBe(false);
    expect(sessions.has(keys.parts)).toBe(false);
  });

  it('returns 204 even when the session does not exist (idempotent)', async () => {
    const sessions = new FakeKV();
    const env = fakeEnv(
      { used: 0, quota: 1024 },
      { SESSIONS: sessions as unknown as KVNamespace },
    );
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });

    const res = await fetcher('/api/videos/upload/never-existed', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});
