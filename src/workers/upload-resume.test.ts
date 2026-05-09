// ALO-134: integration-style tests for the resumable chunked upload
// endpoints exposed by videos.ts. We exercise the routes end-to-end
// against in-memory KV + R2 fakes so the manifest persistence is real,
// but skip the production deps (DB, queue) that would otherwise force
// massive stubbing — the tests focus on the resume primitives, not the
// commit-to-D1 flow which the existing videos.test.ts already covers.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { videoRoutes, type VideoRoutesEnv } from './videos';
import { manifestKey, saveManifest, type UploadManifest } from './chunked-upload';

type TestUser = { id: string; email: string; name: string; emailVerified?: boolean } | null;

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
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
}

interface FakeR2State {
  aborted: string[];
}

function fakeR2(state: FakeR2State): R2Bucket {
  return {
    resumeMultipartUpload(_key: string, uploadId: string) {
      return {
        uploadId,
        async abort() {
          state.aborted.push(uploadId);
        },
      };
    },
  } as unknown as R2Bucket;
}

function buildEnv(state: FakeR2State): VideoRoutesEnv {
  return {
    DB: {} as unknown as D1Database,
    VIDEOS: fakeR2(state),
    CACHE: {} as unknown as KVNamespace,
    SESSIONS: fakeKV(),
    VIDEO_ENCODING: {} as unknown as Queue,
  };
}

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

function seedManifest(overrides: Partial<UploadManifest> = {}): UploadManifest {
  return {
    videoId: 'vid-1',
    r2Key: 'u1/vid-1/clip.mp4',
    multipartUploadId: 'r2-mp-1',
    title: 'My clip',
    description: '',
    fileName: 'clip.mp4',
    contentType: 'video/mp4',
    chunkCount: 4,
    parts: {
      '1': { etag: 'e1', size: 100 },
      '3': { etag: 'e3', size: 250 },
    },
    createdAt: 0,
    ...overrides,
  };
}

describe('GET /api/videos/upload/:uploadId/status', () => {
  it('401s when no session', async () => {
    const env = buildEnv({ aborted: [] });
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/upload/up-1/status');
    expect(res.status).toBe(401);
  });

  it('404s when the manifest is missing or expired', async () => {
    const env = buildEnv({ aborted: [] });
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/missing/status');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('upload_not_found');
  });

  it('returns received chunks, bytes, and the next missing chunkIndex', async () => {
    const env = buildEnv({ aborted: [] });
    await saveManifest(env, 'u1', 'up-1', seedManifest());
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/up-1/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadId: string;
      chunkCount: number;
      receivedChunks: number[];
      receivedBytes: number;
      nextChunkIndex: number | null;
      complete: boolean;
    };
    expect(body).toEqual({
      uploadId: 'up-1',
      chunkCount: 4,
      // chunkIndex = partNumber - 1, so parts {1, 3} → chunks {0, 2};
      // first gap (and so the resume point) is chunkIndex=1.
      receivedChunks: [0, 2],
      receivedBytes: 350,
      nextChunkIndex: 1,
      complete: false,
    });
  });

  it("isolates manifests by user (cannot read another user's upload)", async () => {
    const env = buildEnv({ aborted: [] });
    await saveManifest(env, 'attacker', 'up-1', seedManifest());
    const fetcher = mountWithUser(env, {
      id: 'victim',
      email: 'v@b.com',
      name: 'V',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/up-1/status');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/videos/upload/:uploadId', () => {
  it('401s when no session', async () => {
    const env = buildEnv({ aborted: [] });
    const fetcher = mountWithUser(env, null);
    const res = await fetcher('/api/videos/upload/up-1', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('404s when the manifest is missing', async () => {
    const env = buildEnv({ aborted: [] });
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('aborts the R2 multipart upload and clears the manifest', async () => {
    const state: FakeR2State = { aborted: [] };
    const env = buildEnv(state);
    await saveManifest(env, 'u1', 'up-1', seedManifest());
    const fetcher = mountWithUser(env, {
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/up-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; uploadId: string };
    expect(body.success).toBe(true);
    expect(body.uploadId).toBe('up-1');
    // R2 multipart was aborted with the persisted upload id...
    expect(state.aborted).toEqual(['r2-mp-1']);
    // ...and the manifest was cleared from KV.
    expect(await env.SESSIONS.get(manifestKey('u1', 'up-1'))).toBeNull();
  });

  it("does not let user A abort user B's upload", async () => {
    const state: FakeR2State = { aborted: [] };
    const env = buildEnv(state);
    await saveManifest(env, 'victim', 'up-1', seedManifest());
    const fetcher = mountWithUser(env, {
      id: 'attacker',
      email: 'x@b.com',
      name: 'X',
      emailVerified: true,
    });
    const res = await fetcher('/api/videos/upload/up-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(state.aborted).toEqual([]);
    // victim's manifest is untouched
    expect(await env.SESSIONS.get(manifestKey('victim', 'up-1'))).not.toBeNull();
  });
});
