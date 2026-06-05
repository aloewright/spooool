import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAiGenMessage } from './ai-video-consumer';
import type { AiGenEnv } from './ai-video-consumer';

// ──────────────────────────────────────────────────────────────────────────────
// Stub builders
// ──────────────────────────────────────────────────────────────────────────────

/** Tracks all DB.prepare().bind().run() / .first() calls */
function makeDbStub() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];

  const makeStmt = (sql: string) => {
    let boundValues: unknown[] = [];
    const stmt: Record<string, unknown> = {
      sql,
      bind: (...args: unknown[]) => {
        boundValues = args;
        return stmt;
      },
      run: vi.fn(async () => {
        runs.push({ sql, binds: [...boundValues] });
        return {};
      }),
      first: vi.fn(async () => null),
    };
    return stmt;
  };

  const db: Record<string, unknown> = {
    prepare: (sql: string) => makeStmt(sql),
    _runs: runs,
  };
  return db;
}

/** Tracks VIDEOS.put() calls */
function makeVideosStub() {
  const puts: Array<{ key: string; body: unknown; contentType: string | undefined }> = [];
  return {
    put: vi.fn(async (key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) => {
      puts.push({ key, body, contentType: opts?.httpMetadata?.contentType });
    }),
    get: vi.fn(async () => null),
    _puts: puts,
  };
}

const FAKE_VIDEO_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** Build a minimal AiGenEnv stub */
function makeEnv(overrides: Partial<{
  aiRunResult: unknown;
  streamUid: string | null;
  aiRunRejects: boolean;
  streamRejects: boolean;
}> = {}): { env: AiGenEnv & { _db: ReturnType<typeof makeDbStub>; _videos: ReturnType<typeof makeVideosStub>; _aiRun: ReturnType<typeof vi.fn> }; fetchMock: ReturnType<typeof vi.fn> } {
  const db = makeDbStub();
  const videos = makeVideosStub();

  const defaultAiResult = { result: { video: 'https://veo.example/video.mp4' } };
  const aiRun = vi.fn(async () => {
    if (overrides.aiRunRejects) throw new Error('Veo model error');
    return overrides.aiRunResult ?? defaultAiResult;
  });

  // Intercept global fetch: route 1 = veo video download, route 2 = CF stream API
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('api.cloudflare.com')) {
      // Stream ingest call
      if (overrides.streamRejects) throw new Error('Stream API unavailable');
      if (overrides.streamUid === null) {
        // Simulate missing uid
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }
      const uid = overrides.streamUid ?? 'stream123';
      return new Response(JSON.stringify({ result: { uid } }), { status: 200 });
    }
    // Video download call
    return new Response(FAKE_VIDEO_BYTES, { status: 200 });
  });

  return {
    env: {
      AI: { run: aiRun as AiGenEnv['AI']['run'] },
      VIDEOS: videos as unknown as R2Bucket,
      DB: db as unknown as D1Database,
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      CF_STREAM_API_TOKEN: 'test-token',
      _db: db,
      _videos: videos,
      _aiRun: aiRun,
    },
    fetchMock,
  };
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('handleAiGenMessage', () => {
  it('drops malformed messages silently without touching DB', async () => {
    const { env, fetchMock } = makeEnv();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await handleAiGenMessage(env, { bad: 'data' });

    expect(fetchMock).not.toHaveBeenCalled();
    const runs = (env._db as ReturnType<typeof makeDbStub>)['_runs'] as Array<{ sql: string }>;
    expect(runs).toHaveLength(0);
  });

  describe('happy path', () => {
    it('calls env.AI.run with google/veo-3.1 and correct input params + gateway option', async () => {
      const { env, fetchMock } = makeEnv();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_test001', userId: 'u1', prompt: 'a sunset timelapse' });

      expect(env._aiRun).toHaveBeenCalledTimes(1);
      const [model, input, opts] = env._aiRun.mock.calls[0] as [string, unknown, unknown];
      expect(model).toBe('google/veo-3.1');
      expect(input).toMatchObject({
        prompt: 'a sunset timelapse',
        duration: '8s',
        aspect_ratio: '16:9',
        resolution: '720p',
        generate_audio: true,
      });
      expect(opts).toEqual({ gateway: { id: 'x' } });
    });

    it('puts video bytes to R2 at studio/video/<assetId>.mp4 with video/mp4 content-type', async () => {
      const { env, fetchMock } = makeEnv();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_abc123', userId: 'u1', prompt: 'test' });

      const puts = (env._videos as ReturnType<typeof makeVideosStub>)._puts;
      expect(puts).toHaveLength(1);
      expect(puts[0].key).toBe('studio/video/a_abc123.mp4');
      expect(puts[0].contentType).toBe('video/mp4');
      // bytes match the fake payload
      expect(puts[0].body).toEqual(FAKE_VIDEO_BYTES);
    });

    it('UPDATEs generated_assets with status=ready, bytes, stream_video_id', async () => {
      const { env, fetchMock } = makeEnv();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_abc123', userId: 'u1', prompt: 'test' });

      const runs = (env._db as ReturnType<typeof makeDbStub>)['_runs'] as Array<{ sql: string; binds: unknown[] }>;
      const updateRun = runs.find((r) => r.sql.includes("status='ready'"));
      expect(updateRun).toBeDefined();
      expect(updateRun!.binds[0]).toBe(FAKE_VIDEO_BYTES.byteLength); // bytes
      expect(updateRun!.binds[1]).toBe('studio/video/a_abc123.mp4');  // r2_key
      expect(updateRun!.binds[2]).toBe('stream123');                  // stream_video_id
      expect(updateRun!.binds[4]).toBe('a_abc123');                   // asset id
      expect(updateRun!.binds[5]).toBe('u1');                         // user id
    });

    it('INSERTs an ai_costs row with unit_kind=seconds', async () => {
      const { env, fetchMock } = makeEnv();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_abc123', userId: 'u1', prompt: 'test' });

      const runs = (env._db as ReturnType<typeof makeDbStub>)['_runs'] as Array<{ sql: string; binds: unknown[] }>;
      const costRun = runs.find((r) => r.sql.includes('INSERT INTO ai_costs'));
      expect(costRun).toBeDefined();
      expect(costRun!.sql).toContain("unit_kind");
      expect(costRun!.sql).toContain("'seconds'");
      expect(costRun!.binds[1]).toBe('u1'); // userId
    });
  });

  describe('failure path — AI.run rejects', () => {
    it('UPDATEs generated_assets status=failed with error_message', async () => {
      const { env, fetchMock } = makeEnv({ aiRunRejects: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_fail01', userId: 'u1', prompt: 'test' });

      const runs = (env._db as ReturnType<typeof makeDbStub>)['_runs'] as Array<{ sql: string; binds: unknown[] }>;
      const failRun = runs.find((r) => r.sql.includes("status='failed'"));
      expect(failRun).toBeDefined();
      expect(typeof failRun!.binds[0]).toBe('string'); // error_message populated
      expect((failRun!.binds[0] as string).length).toBeGreaterThan(0);
      expect(failRun!.binds[2]).toBe('a_fail01'); // assetId
      expect(failRun!.binds[3]).toBe('u1');        // userId
    });

    it('does NOT throw — always acks the message', async () => {
      const { env, fetchMock } = makeEnv({ aiRunRejects: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // Must resolve without throwing
      await expect(
        handleAiGenMessage(env, { assetId: 'a_fail01', userId: 'u1', prompt: 'test' }),
      ).resolves.toBeUndefined();
    });

    it('does NOT write to VIDEOS when generation fails', async () => {
      const { env, fetchMock } = makeEnv({ aiRunRejects: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_fail01', userId: 'u1', prompt: 'test' });

      const puts = (env._videos as ReturnType<typeof makeVideosStub>)._puts;
      expect(puts).toHaveLength(0);
    });
  });

  describe('stream-fail path — sendToStream rejects', () => {
    it('still marks generated_assets status=ready when Stream ingest fails', async () => {
      const { env, fetchMock } = makeEnv({ streamRejects: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_nst01', userId: 'u1', prompt: 'test' });

      const runs = (env._db as ReturnType<typeof makeDbStub>)['_runs'] as Array<{ sql: string; binds: unknown[] }>;
      const readyRun = runs.find((r) => r.sql.includes("status='ready'"));
      expect(readyRun).toBeDefined();
    });

    it('sets stream_video_id to null when Stream ingest fails', async () => {
      const { env, fetchMock } = makeEnv({ streamRejects: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleAiGenMessage(env, { assetId: 'a_nst01', userId: 'u1', prompt: 'test' });

      const runs = (env._db as ReturnType<typeof makeDbStub>)['_runs'] as Array<{ sql: string; binds: unknown[] }>;
      const readyRun = runs.find((r) => r.sql.includes("status='ready'"));
      expect(readyRun!.binds[2]).toBeNull(); // stream_video_id = null
    });

    it('does NOT throw when Stream ingest fails', async () => {
      const { env, fetchMock } = makeEnv({ streamRejects: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        handleAiGenMessage(env, { assetId: 'a_nst01', userId: 'u1', prompt: 'test' }),
      ).resolves.toBeUndefined();
    });
  });
});
