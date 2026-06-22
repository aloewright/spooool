import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { videoRoutes, type VideoRoutesEnv } from './videos';

vi.mock('./turnstile', () => ({
  verifyTurnstile: vi.fn(async () => ({ success: true })),
}));

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
    fd.set('file', new Blob([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0])], { type: 'video/webm' }), 'take.webm');
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
    fd.set('file', new Blob([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0])], { type: 'video/webm' }), 'take.webm');
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
    fd0.set('file', new Blob([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, ...new Array(508).fill(0)])], { type: 'video/webm' }), 'take.webm');
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
    fd0.set('file', new Blob([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, ...new Array(508).fill(0)])], { type: 'video/webm' }), 'take.webm');
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
    fd0.set('file', new Blob([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, ...new Array(508).fill(0)])], { type: 'video/webm' }), 'take.webm');
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
    // Current usage 100, quota 110, new file 20 -> overflow
    const fetcher = mountWithUser(
      fakeEnv({ used: 100, quota: 110 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true },
    );
    const fd = new FormData();
    fd.set('title', 'big');
    fd.set('file', new Blob([new Uint8Array(20)], { type: 'video/mp4' }), 'big.mp4');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; storage: QuotaState };
    expect(body.code).toBe('storage_quota_exceeded');
    expect(body.storage.used).toBe(100);
  });

  it('lets the upload through when there is room', async () => {
    // Current usage 50, quota 100, new file 10 -> ok
    const fetcher = mountWithUser(
      fakeEnv({ used: 50, quota: 100 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true },
    );
    const fd = new FormData();
    fd.set('title', 'hi');
    fd.set('description', '');
    // Valid MP4 ftyp box (size=16, 'ftyp', brand='isom') so magic-byte check passes.
    fd.set('file', new Blob([new Uint8Array([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D])], { type: 'video/mp4' }), 'clip.mp4');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');
    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
  });
});

// Multi-chunk video upload: DB row created at chunk 0 with status='uploading'
describe('POST /api/videos/upload multi-chunk (target=video)', () => {
  const USER_ID = 'u_mc';

  function multiChunkEnv() {
    const dbInserts: { sql: string; bound: unknown[] }[] = [];
    const dbUpdates: { sql: string; bound: unknown[] }[] = [];
    const r2Parts: Record<string, { partNumber: number }[]> = {};
    const r2Completed: string[] = [];
    const kv: Record<string, string> = {};
    const queueSends: unknown[] = [];

    const DB = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...v: unknown[]) { bound = v; return stmt; },
          async run() {
            if (sql.includes('INSERT INTO videos')) dbInserts.push({ sql, bound: [...bound] });
            if (sql.includes('UPDATE videos') && sql.includes('SET status')) dbUpdates.push({ sql, bound: [...bound] });
            return { success: true, meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('SUM(bytes)')) return { used: 0 };
            if (sql.includes('storage_bytes_quota')) return { quota: 10 * 1024 * 1024 * 1024 };
            return null;
          },
          async all() { return { results: [] }; },
        };
        void bound;
        return stmt;
      },
    } as unknown as D1Database;

    const VIDEOS = {
      put: async () => {},
      createMultipartUpload: async (key: string) => {
        r2Parts[key] = [];
        return {
          uploadId: `mpid-${key}`,
          uploadPart: async (partNumber: number) => {
            r2Parts[key]!.push({ partNumber });
            return { etag: `etag-${partNumber}` };
          },
        };
      },
      resumeMultipartUpload: (key: string) => ({
        uploadPart: async (partNumber: number) => {
          if (!r2Parts[key]) r2Parts[key] = [];
          r2Parts[key]!.push({ partNumber });
          return { etag: `etag-${partNumber}` };
        },
        complete: async () => { r2Completed.push(key); },
        abort: async () => {},
      }),
    } as unknown as R2Bucket;

    const SESSIONS = {
      put: async (k: string, v: string) => { kv[k] = v; },
      get: async (k: string) => kv[k] ?? null,
      delete: async (k: string) => { delete kv[k]; },
    } as unknown as KVNamespace;

    const VIDEO_ENCODING = {
      send: async (msg: unknown) => { queueSends.push(msg); },
    } as unknown as Queue;

    const CACHE = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;

    const env = { DB, VIDEOS, SESSIONS, CACHE, VIDEO_ENCODING } as unknown as VideoRoutesEnv;
    return { env, dbInserts, dbUpdates, r2Parts, r2Completed, kv, queueSends };
  }

  const MP4_MAGIC = new Uint8Array([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);

  it('chunk 0 creates a DB row with status=uploading and returns videoId', async () => {
    const { env, dbInserts } = multiChunkEnv();
    const fetcher = mountWithUser(env, { id: USER_ID, email: 'u@t.com', name: 'U', emailVerified: true });

    const fd = new FormData();
    fd.set('title', 'my video');
    fd.set('description', 'desc');
    fd.set('file', new Blob([MP4_MAGIC], { type: 'video/mp4' }), 'video.mp4');
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '2');

    const res = await fetcher('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; videoId: string; uploadId: string };
    expect(body.status).toBe('chunk_received');
    expect(typeof body.videoId).toBe('string');
    expect(typeof body.uploadId).toBe('string');

    // DB INSERT with status='uploading'
    expect(dbInserts).toHaveLength(1);
    const [insert] = dbInserts;
    expect(insert!.sql).toContain('uploading');
    // bound: [videoId, userId, title, description, r2Key]
    expect(insert!.bound[1]).toBe(USER_ID);
    expect(insert!.bound[2]).toBe('my video');
  });

  it('retrying the final chunk after KV cleanup returns 201 via done sentinel', async () => {
    const { env, kv } = multiChunkEnv();
    const fetcher = mountWithUser(env, { id: USER_ID, email: 'u@t.com', name: 'U', emailVerified: true });

    // chunk 0
    const fd0 = new FormData();
    fd0.set('title', 'vid');
    fd0.set('description', '');
    fd0.set('file', new Blob([MP4_MAGIC], { type: 'video/mp4' }), 'v.mp4');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '2');
    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const { videoId, uploadId } = (await res0.json()) as { videoId: string; uploadId: string };

    // chunk 1 (final) — completes successfully
    const fd1 = new FormData();
    fd1.set('title', 'vid');
    fd1.set('description', '');
    fd1.set('file', new Blob([new Uint8Array(512)], { type: 'video/mp4' }), 'v.mp4');
    fd1.set('chunkIndex', '1');
    fd1.set('chunkCount', '2');
    fd1.set('uploadId', uploadId);
    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(201);

    // Done sentinel must be present after successful completion.
    const doneKey = `upload-done:${USER_ID}:${uploadId}`;
    expect(kv[doneKey]).toBeDefined();

    // Simulate: client never received the 201 (dropped connection) and retries.
    // Session keys are gone but the done sentinel remains in KV.
    const fd1Retry = new FormData();
    fd1Retry.set('title', 'vid');
    fd1Retry.set('description', '');
    fd1Retry.set('file', new Blob([new Uint8Array(512)], { type: 'video/mp4' }), 'v.mp4');
    fd1Retry.set('chunkIndex', '1');
    fd1Retry.set('chunkCount', '2');
    fd1Retry.set('uploadId', uploadId);
    const res1Retry = await fetcher('/api/videos/upload', { method: 'POST', body: fd1Retry });
    expect(res1Retry.status).toBe(201);
    const bodyRetry = (await res1Retry.json()) as { id: string; status: string };
    expect(bodyRetry.id).toBe(videoId);
    expect(bodyRetry.status).toBe('queued');
  });

  it('final chunk transitions existing row to queued, returns same videoId', async () => {
    const { env, dbInserts, dbUpdates, queueSends } = multiChunkEnv();
    const fetcher = mountWithUser(env, { id: USER_ID, email: 'u@t.com', name: 'U', emailVerified: true });

    // chunk 0
    const fd0 = new FormData();
    fd0.set('title', 'vid');
    fd0.set('description', '');
    fd0.set('file', new Blob([MP4_MAGIC], { type: 'video/mp4' }), 'v.mp4');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '2');
    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const { videoId, uploadId } = (await res0.json()) as { videoId: string; uploadId: string };

    // chunk 1 (final)
    const fd1 = new FormData();
    fd1.set('title', 'vid');
    fd1.set('description', '');
    fd1.set('file', new Blob([new Uint8Array(512)], { type: 'video/mp4' }), 'v.mp4');
    fd1.set('chunkIndex', '1');
    fd1.set('chunkCount', '2');
    fd1.set('uploadId', uploadId);
    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { id: string; status: string };
    // Returns the same videoId that was created at chunk 0
    expect(body1.id).toBe(videoId);
    expect(body1.status).toBe('queued');

    // INSERT at chunk 0, UPDATE at final chunk (no second INSERT)
    expect(dbInserts).toHaveLength(1);
    expect(dbUpdates).toHaveLength(1);
    expect(dbUpdates[0]!.sql).toContain("SET status = 'queued'");

    // Encoding queue received the job
    expect(queueSends).toHaveLength(1);
    expect((queueSends[0] as { videoId: string }).videoId).toBe(videoId);
  });
});

describe('GET /api/account/storage', () => {
  it('returns 401 when not signed in', async () => {
    const fetcher = mountWithUser(fakeEnv({ used: 0, quota: 5 * 1024 * 1024 * 1024 }), null);
    const res = await fetcher('/api/account/storage');
    expect(res.status).toBe(401);
  });

  it('returns used/quota/remaining for signed-in user', async () => {
    const fetcher = mountWithUser(
      fakeEnv({ used: 1_000_000, quota: 5 * 1024 * 1024 * 1024 }),
      { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true },
    );
    const res = await fetcher('/api/account/storage');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { used: number; quota: number; remaining: number };
    expect(body.used).toBe(1_000_000);
    expect(body.quota).toBe(5 * 1024 * 1024 * 1024);
    expect(body.remaining).toBe(5 * 1024 * 1024 * 1024 - 1_000_000);
  });
});

describe('KV TTL refresh on middle chunks', () => {
  const USER_ID = 'u_ttl';
  const MP4_MAGIC = new Uint8Array([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);

  function ttlEnv() {
    // Tracks each KV put() call so we can verify mpidKey and metaKey are
    // refreshed alongside partsKey on middle chunks.
    const kvPuts: { key: string; ttl: number | undefined }[] = [];
    const kv: Record<string, string> = {};

    const SESSIONS = {
      put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
        kvPuts.push({ key: k, ttl: opts?.expirationTtl });
        kv[k] = v;
      },
      get: async (k: string) => kv[k] ?? null,
      delete: async (k: string) => { delete kv[k]; },
    } as unknown as KVNamespace;

    const DB = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...v: unknown[]) { bound = v; return stmt; },
          async run() { return { success: true, meta: { changes: 1 } }; },
          async first() {
            if (sql.includes('SUM(bytes)')) return { used: 0 };
            if (sql.includes('storage_bytes_quota')) return { quota: 10 * 1024 * 1024 * 1024 };
            return null;
          },
          async all() { return { results: [] }; },
        };
        void bound;
        return stmt;
      },
    } as unknown as D1Database;

    const VIDEOS = {
      put: async () => {},
      createMultipartUpload: async (key: string) => ({
        uploadId: `mpid-${key}`,
        uploadPart: async (n: number) => ({ etag: `e${n}` }),
      }),
      resumeMultipartUpload: (key: string, mpid: string) => ({
        uploadPart: async (n: number) => ({ etag: `e${n}` }),
        complete: async () => {},
        abort: async () => {},
      }),
    } as unknown as R2Bucket;

    const env = {
      DB, VIDEOS, SESSIONS,
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace,
      VIDEO_ENCODING: { send: async () => {} } as unknown as Queue,
    } as unknown as VideoRoutesEnv;
    return { env, kvPuts };
  }

  it('refreshes mpidKey and metaKey TTL on middle chunks', async () => {
    const { env, kvPuts } = ttlEnv();
    const fetcher = mountWithUser(env, { id: USER_ID, email: 'u@t.com', name: 'U', emailVerified: true });

    // 3-chunk upload: send chunk 0, then chunk 1 (middle), and observe KV writes
    const fd0 = new FormData();
    fd0.set('title', 'vid');
    fd0.set('description', '');
    fd0.set('file', new Blob([MP4_MAGIC], { type: 'video/mp4' }), 'v.mp4');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '3');
    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const { uploadId } = (await res0.json()) as { uploadId: string };

    kvPuts.length = 0; // reset: only observe middle-chunk writes

    const fd1 = new FormData();
    fd1.set('title', 'vid');
    fd1.set('description', '');
    fd1.set('file', new Blob([new Uint8Array(512)], { type: 'video/mp4' }), 'v.mp4');
    fd1.set('chunkIndex', '1');
    fd1.set('chunkCount', '3');
    fd1.set('uploadId', uploadId);
    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(202);

    // All three KV keys must have been written with a TTL (=refreshed)
    const baseKey = `upload:${USER_ID}:${uploadId}`;
    const refreshed = kvPuts.filter((p) => p.ttl === 86400).map((p) => p.key);
    expect(refreshed).toContain(`${baseKey}:mpid`);
    expect(refreshed).toContain(`${baseKey}:meta`);
    expect(refreshed).toContain(`${baseKey}:parts`);
  });
});

describe('sentinel written before KV session cleanup', () => {
  const USER_ID = 'u_sentinel';
  const MP4_MAGIC = new Uint8Array([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);

  it('sentinel key exists in KV when session keys are deleted', async () => {
    // We need to observe the exact order: sentinel written, then session deleted.
    const events: string[] = [];
    const kv: Record<string, string> = {};

    const SESSIONS = {
      put: async (k: string, v: string, _opts?: unknown) => {
        kv[k] = v;
        if (k.startsWith('upload-done:')) events.push(`write:${k}`);
      },
      get: async (k: string) => kv[k] ?? null,
      delete: async (k: string) => {
        events.push(`delete:${k}`);
        delete kv[k];
      },
    } as unknown as KVNamespace;

    const DB = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...v: unknown[]) { bound = v; return stmt; },
          async run() { return { success: true, meta: { changes: 1 } }; },
          async first() {
            if (sql.includes('SUM(bytes)')) return { used: 0 };
            if (sql.includes('storage_bytes_quota')) return { quota: 10 * 1024 * 1024 * 1024 };
            return null;
          },
          async all() { return { results: [] }; },
        };
        void bound;
        return stmt;
      },
    } as unknown as D1Database;

    const VIDEOS = {
      put: async () => {},
      createMultipartUpload: async (key: string) => ({
        uploadId: `mpid-${key}`,
        uploadPart: async (n: number) => ({ etag: `e${n}` }),
      }),
      resumeMultipartUpload: (_key: string, _mpid: string) => ({
        uploadPart: async (n: number) => ({ etag: `e${n}` }),
        complete: async () => {},
        abort: async () => {},
      }),
    } as unknown as R2Bucket;

    const env = {
      DB, VIDEOS, SESSIONS,
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace,
      VIDEO_ENCODING: { send: async () => {} } as unknown as Queue,
    } as unknown as VideoRoutesEnv;
    const fetcher = mountWithUser(env, { id: USER_ID, email: 'u@t.com', name: 'U', emailVerified: true });

    // chunk 0
    const fd0 = new FormData();
    fd0.set('title', 'vid');
    fd0.set('description', '');
    fd0.set('file', new Blob([MP4_MAGIC], { type: 'video/mp4' }), 'v.mp4');
    fd0.set('chunkIndex', '0');
    fd0.set('chunkCount', '2');
    const res0 = await fetcher('/api/videos/upload', { method: 'POST', body: fd0 });
    expect(res0.status).toBe(202);
    const { uploadId } = (await res0.json()) as { uploadId: string };

    events.length = 0; // only care about final-chunk ordering

    // chunk 1 (final)
    const fd1 = new FormData();
    fd1.set('title', 'vid');
    fd1.set('description', '');
    fd1.set('file', new Blob([new Uint8Array(512)], { type: 'video/mp4' }), 'v.mp4');
    fd1.set('chunkIndex', '1');
    fd1.set('chunkCount', '2');
    fd1.set('uploadId', uploadId);
    const res1 = await fetcher('/api/videos/upload', { method: 'POST', body: fd1 });
    expect(res1.status).toBe(201);

    const sentinelWriteIdx = events.findIndex((e) => e.startsWith('write:upload-done:'));
    const firstDeleteIdx = events.findIndex((e) => e.startsWith('delete:'));
    expect(sentinelWriteIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeleteIdx).toBeGreaterThan(sentinelWriteIdx);
  });
});

describe('DELETE /api/videos/:id cache invalidation (ALO-431)', () => {
  it('deletes videoMetaCacheKey from KV when the owner deletes their video', async () => {
    const cacheDeletes: string[] = [];
    const videoId = 'vid-del-cache';
    const ownerId = 'owner-del';

    const CACHE = {
      delete: async (key: string) => { cacheDeletes.push(key); },
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace;

    const DB = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...v: unknown[]) { bound = v; return stmt; },
          async first() {
            if (sql.includes('SELECT id, user_id, r2_key FROM videos')) {
              return { id: videoId, user_id: ownerId, r2_key: `${ownerId}/${videoId}/raw.mp4` };
            }
            return null;
          },
          async run() { return { success: true }; },
        };
        void bound;
        return stmt;
      },
    } as unknown as D1Database;

    const VIDEOS = { delete: async () => {} } as unknown as R2Bucket;
    const env = { DB, CACHE, VIDEOS, SESSIONS: {} as KVNamespace, VIDEO_ENCODING: { send: async () => {} } as unknown as Queue };

    const fetcher = mountWithUser(env, { id: ownerId, email: 'o@t.com', name: 'Owner', emailVerified: true });
    const res = await fetcher(`/api/videos/${videoId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(cacheDeletes).toContain(`video:v1:${videoId}`);
  });
});
