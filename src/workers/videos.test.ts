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

describe('POST /api/videos/upload (target=recorder)', () => {
  const TEST_USER_ID = 'user_rec1';

  // Build a full env stub that captures R2 puts/multipart, KV reads/writes,
  // and asserts that DB.prepare (video insert) and VIDEO_ENCODING.send are
  // never called on the recorder path.
  function recorderEnv() {
    const r2Puts: { key: string }[] = [];
    const r2Parts: Record<string, { parts: { partNumber: number; body: unknown }[] }> = {};
    const r2Completed: string[] = [];
    const r2Aborted: string[] = [];
    const kv: Record<string, string> = {};
    const dbCalls: string[] = [];
    const queueSends: unknown[] = [];

    const VIDEOS = {
      put: async (key: string, _body: unknown, _opts?: unknown) => {
        r2Puts.push({ key });
      },
      createMultipartUpload: async (key: string, _opts?: unknown) => {
        r2Parts[key] = { parts: [] };
        const mpid = `mpid-${key}`;
        return {
          uploadId: mpid,
          uploadPart: async (partNumber: number, body: unknown) => {
            r2Parts[key]!.parts.push({ partNumber, body });
            return { etag: `etag-${partNumber}` };
          },
        };
      },
      resumeMultipartUpload: (key: string, _mpid: string) => {
        return {
          uploadPart: async (partNumber: number, body: unknown) => {
            if (!r2Parts[key]) r2Parts[key] = { parts: [] };
            r2Parts[key]!.parts.push({ partNumber, body });
            return { etag: `etag-${partNumber}` };
          },
          complete: async (_parts: unknown) => {
            r2Completed.push(key);
          },
          abort: async () => {
            r2Aborted.push(key);
          },
        };
      },
    } as unknown as R2Bucket;

    const SESSIONS = {
      put: async (k: string, v: string, _opts?: unknown) => {
        kv[k] = v;
      },
      get: async (k: string) => kv[k] ?? null,
      delete: async (k: string) => {
        delete kv[k];
      },
    } as unknown as KVNamespace;

    const DB = {
      prepare(sql: string) {
        return {
          bind(..._v: unknown[]) { return this; },
          async run() {
            dbCalls.push(sql);
            return { success: true };
          },
          async first() { return null; },
          async all() { return { results: [] }; },
        };
      },
    } as unknown as D1Database;

    const VIDEO_ENCODING = {
      send: async (msg: unknown) => { queueSends.push(msg); },
    } as unknown as Queue;

    const env: VideoRoutesEnv = {
      DB,
      VIDEOS,
      CACHE: { delete: async () => {}, get: async () => null, put: async () => {} } as unknown as KVNamespace,
      SESSIONS,
      VIDEO_ENCODING,
    };

    return { env, r2Puts, r2Parts, r2Completed, r2Aborted, kv, dbCalls, queueSends };
  }

  function recorderFetcher() {
    const stubs = recorderEnv();
    const fetcher = mountWithUser(
      stubs.env,
      { id: TEST_USER_ID, email: 'rec@test.com', name: 'Rec', emailVerified: true },
    );
    return { fetcher, stubs };
  }

  it('writes the recorder take under recorder/raw/{userId}/{sessionId}/{takeId}.webm and returns r2Key', async () => {
    const { fetcher, stubs } = recorderFetcher();

    const fd = new FormData();
    fd.set('target', 'recorder');
    fd.set('sessionId', 'sess_x');
    fd.set('takeId', 'take_001');
    fd.set('file', new Blob([new Uint8Array(8)], { type: 'video/webm' }), 'take.webm');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');

    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; r2Key: string };
    const expectedKey = `recorder/raw/${TEST_USER_ID}/sess_x/take_001.webm`;
    expect(body.ok).toBe(true);
    expect(body.r2Key).toBe(expectedKey);
    // R2 received the take at the correct key
    expect(stubs.r2Puts.map(p => p.key)).toContain(expectedKey);
    // No videos INSERT
    expect(stubs.dbCalls.some(s => s.includes('INSERT INTO videos'))).toBe(false);
    // No VIDEO_ENCODING send
    expect(stubs.queueSends.length).toBe(0);
  });

  it('400s on missing sessionId or takeId', async () => {
    const { fetcher } = recorderFetcher();

    // Missing takeId
    const fd1 = new FormData();
    fd1.set('target', 'recorder');
    fd1.set('sessionId', 'sess_x');
    fd1.set('file', new Blob([new Uint8Array(4)], { type: 'video/webm' }), 'take.webm');
    fd1.set('chunkIndex', '0');
    fd1.set('chunkCount', '1');
    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(400);

    // Missing sessionId
    const fd2 = new FormData();
    fd2.set('target', 'recorder');
    fd2.set('takeId', 'take_001');
    fd2.set('file', new Blob([new Uint8Array(4)], { type: 'video/webm' }), 'take.webm');
    fd2.set('chunkIndex', '0');
    fd2.set('chunkCount', '1');
    const res2 = await fetcher('/api/videos/upload', { method: 'POST', body: fd2 });
    expect(res2.status).toBe(400);
  });

  it('400s on sessionId or takeId not matching /^[A-Za-z0-9_-]{1,64}$/', async () => {
    const { fetcher } = recorderFetcher();

    const badValues = ['../escape', 'has space', 'has/slash', '<script>'];
    for (const bad of badValues) {
      const fd = new FormData();
      fd.set('target', 'recorder');
      fd.set('sessionId', bad);
      fd.set('takeId', 'take_001');
      fd.set('file', new Blob([new Uint8Array(4)], { type: 'video/webm' }), 'take.webm');
      fd.set('chunkIndex', '0');
      fd.set('chunkCount', '1');
      const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
      expect(res.status, `expected 400 for sessionId=${bad}`).toBe(400);
    }
  });

  it('does not enforce title / description for recorder uploads', async () => {
    const { fetcher } = recorderFetcher();

    const fd = new FormData();
    fd.set('target', 'recorder');
    fd.set('sessionId', 'sess_y');
    fd.set('takeId', 'take_002');
    // Intentionally no title / description
    fd.set('file', new Blob([new Uint8Array(8)], { type: 'video/webm' }), 'take.webm');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');

    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; r2Key: string };
    expect(body.ok).toBe(true);
  });

  it('threads multi-chunk uploads through R2 multipart and writes only on final chunk', async () => {
    const { fetcher, stubs } = recorderFetcher();

    const sessionId = 'sess_multi';
    const takeId = 'take_mc';
    const expectedKey = `recorder/raw/${TEST_USER_ID}/${sessionId}/${takeId}.webm`;

    // Chunk 0 — should return 202 with uploadId
    const fd0 = new FormData();
    fd0.set('target', 'recorder');
    fd0.set('sessionId', sessionId);
    fd0.set('takeId', takeId);
    fd0.set('file', new Blob([new Uint8Array(512)], { type: 'video/webm' }), 'take.webm');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '2');

    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const body0 = (await res0.json()) as { status: string; uploadId: string };
    expect(body0.status).toBe('chunk_received');
    expect(typeof body0.uploadId).toBe('string');

    const { uploadId } = body0;

    // Chunk 1 (final) — should return 200 with r2Key
    const fd1 = new FormData();
    fd1.set('target', 'recorder');
    fd1.set('sessionId', sessionId);
    fd1.set('takeId', takeId);
    fd1.set('file', new Blob([new Uint8Array(256)], { type: 'video/webm' }), 'take.webm');
    fd1.set('chunkIndex', '1');
    fd1.set('chunkCount', '2');
    fd1.set('uploadId', uploadId);

    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; r2Key: string };
    expect(body1.ok).toBe(true);
    expect(body1.r2Key).toBe(expectedKey);

    // Multipart completed to the recorder/raw/ key, not the videos prefix
    expect(stubs.r2Completed).toContain(expectedKey);
    // No DB inserts, no queue sends
    expect(stubs.dbCalls.some(s => s.includes('INSERT INTO videos'))).toBe(false);
    expect(stubs.queueSends.length).toBe(0);
  });

  it('rejects the final chunk when fewer parts were uploaded than chunkCount', async () => {
    const { fetcher, stubs } = recorderFetcher();

    const sessionId = 'sess_missingpart';
    const takeId = 'take_mp';

    // 3-chunk upload: send chunk 0 (registers mpid + meta + parts[1])
    const fd0 = new FormData();
    fd0.set('target', 'recorder');
    fd0.set('sessionId', sessionId);
    fd0.set('takeId', takeId);
    fd0.set('file', new Blob([new Uint8Array(512)], { type: 'video/webm' }), 'take.webm');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '3');

    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const body0 = (await res0.json()) as { uploadId: string };
    const { uploadId } = body0;

    // Skip chunk 1. Send chunk 2 (the final, chunkIndex=2, chunkCount=3).
    // At this point only parts 1 and 3 are recorded (2 out of 3 expected).
    const fd2 = new FormData();
    fd2.set('target', 'recorder');
    fd2.set('sessionId', sessionId);
    fd2.set('takeId', takeId);
    fd2.set('file', new Blob([new Uint8Array(256)], { type: 'video/webm' }), 'take.webm');
    fd2.set('chunkIndex', '2');
    fd2.set('chunkCount', '3');
    fd2.set('uploadId', uploadId);

    const res2 = await fetcher('/api/videos/upload', { method: 'POST', body: fd2 });
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toMatch(/missing one or more chunks/i);
    // multipart.complete() must NOT have been called
    const expectedKey = `recorder/raw/${TEST_USER_ID}/${sessionId}/${takeId}.webm`;
    expect(stubs.r2Completed).not.toContain(expectedKey);
  });

  it('aborts the orphan multipart when the KV session meta is missing', async () => {
    const { fetcher, stubs } = recorderFetcher();

    const sessionId = 'sess_orphan';
    const takeId = 'take_orph';
    const expectedKey = `recorder/raw/${TEST_USER_ID}/${sessionId}/${takeId}.webm`;

    // chunk 0 — succeeds, records mpid + meta in KV
    const fd0 = new FormData();
    fd0.set('target', 'recorder');
    fd0.set('sessionId', sessionId);
    fd0.set('takeId', takeId);
    fd0.set('file', new Blob([new Uint8Array(512)], { type: 'video/webm' }), 'take.webm');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '2');

    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const { uploadId } = (await res0.json()) as { uploadId: string };

    // Simulate KV TTL expiry: delete the meta key but leave mpid intact
    const baseKvKey = `upload:rec:${TEST_USER_ID}:${uploadId}`;
    delete stubs.kv[`${baseKvKey}:meta`];

    // chunk 1 — should 400 because meta is gone, and abort() should be called
    const fd1 = new FormData();
    fd1.set('target', 'recorder');
    fd1.set('sessionId', sessionId);
    fd1.set('takeId', takeId);
    fd1.set('file', new Blob([new Uint8Array(256)], { type: 'video/webm' }), 'take.webm');
    fd1.set('chunkIndex', '1');
    fd1.set('chunkCount', '2');
    fd1.set('uploadId', uploadId);

    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(400);
    const body1 = (await res1.json()) as { error: string };
    expect(body1.error).toMatch(/missing upload session/i);

    // abort() must have been called for the orphaned multipart
    expect(stubs.r2Aborted).toContain(expectedKey);
  });

  it('400s on invalid uploadId format', async () => {
    const { fetcher } = recorderFetcher();

    const fd = new FormData();
    fd.set('target', 'recorder');
    fd.set('sessionId', 'sess_valid');
    fd.set('takeId', 'take_valid');
    fd.set('file', new Blob([new Uint8Array(4)], { type: 'video/webm' }), 'take.webm');
    fd.set('chunkIndex', '1');
    fd.set('chunkCount', '2');
    fd.set('uploadId', '../bad');

    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid uploadId');
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
