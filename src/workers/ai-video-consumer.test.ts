import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAiGenMessage, type AiVideoEnv } from './ai-video-consumer';

// ---------- helpers ----------

interface DbRun { sql: string; bound: unknown[] }

function fakeDB() {
  const runs: DbRun[] = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => { bound = values; return stmt; },
      run: async () => { runs.push({ sql, bound: [...bound] }); return { meta: { changes: 1 } }; },
    };
    return stmt;
  };
  return { prepare, runs } as unknown as D1Database & { runs: DbRun[] };
}

function fakeR2() {
  const puts: Array<{ key: string; size: number }> = [];
  return {
    put: async (key: string, value: ArrayBuffer) => { puts.push({ key, size: value.byteLength }); },
    puts,
  } as unknown as R2Bucket & { puts: Array<{ key: string; size: number }> };
}

function fakeAI(videoUrl = 'https://r2.example.com/ai-video.mp4') {
  const calls: Array<{ model: string; input: unknown; opts: unknown }> = [];
  return {
    run: vi.fn(async (model: string, input: unknown, opts: unknown) => {
      calls.push({ model, input, opts });
      return { result: { video: videoUrl } };
    }),
    calls,
  };
}

const VALID_MESSAGE = {
  assetId: 'asset-1',
  userId: 'user-1',
  prompt: 'a sunset over mountains',
  duration: 5,
};

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

// ---------- tests ----------

describe('handleAiGenMessage', () => {
  it('returns silently on a malformed message without touching DB', async () => {
    const db = fakeDB();
    const ai = fakeAI();
    const r2 = fakeR2();
    await handleAiGenMessage(
      { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
      { not: 'valid' },
    );
    expect(db.runs).toHaveLength(0);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('calls env.AI.run with google/veo-3.1 + gateway opts — NOT a compat-fetch URL', async () => {
    const db = fakeDB();
    const ai = fakeAI('https://r2.cf.example/veo.mp4');
    const r2 = fakeR2();

    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array(8).buffer, { status: 200 }),
    ) as unknown as typeof fetch;

    await handleAiGenMessage(
      { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
      VALID_MESSAGE,
    );

    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input, opts] = ai.run.mock.calls[0] as [string, unknown, unknown];
    expect(model).toBe('google/veo-3.1');
    expect((input as Record<string, unknown>).prompt).toBe('a sunset over mountains');
    expect(opts).toEqual({ gateway: { id: 'x' } });
  });

  it('stages video to R2 at studio/video/{assetId}.mp4 and sets bytes', async () => {
    const db = fakeDB();
    const ai = fakeAI('https://r2.cf.example/veo.mp4');
    const r2 = fakeR2();
    const videoData = new Uint8Array([1, 2, 3, 4, 5, 6]);

    globalThis.fetch = vi.fn(async () =>
      new Response(videoData.buffer, { status: 200 }),
    ) as unknown as typeof fetch;

    await handleAiGenMessage(
      { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
      VALID_MESSAGE,
    );

    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0].key).toBe('studio/video/asset-1.mp4');
    expect(r2.puts[0].size).toBe(6);
  });

  it('writes generated_assets status→ready and ai_costs row on success', async () => {
    const db = fakeDB();
    const ai = fakeAI('https://r2.cf.example/veo.mp4');
    const r2 = fakeR2();

    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array(100).buffer, { status: 200 }),
    ) as unknown as typeof fetch;

    await handleAiGenMessage(
      { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
      VALID_MESSAGE,
    );

    const updates = db.runs.filter((r) => r.sql.includes('UPDATE generated_assets'));
    // First UPDATE: queued→processing. Second UPDATE: →ready with r2_key + bytes.
    expect(updates).toHaveLength(2);
    expect(updates[0].bound[0]).toBe('processing');
    expect(updates[1].bound[0]).toBe('ready');
    expect(updates[1].bound[1]).toBe('studio/video/asset-1.mp4');
    expect(updates[1].bound[3]).toBe(100); // bytes

    const costInserts = db.runs.filter((r) => r.sql.includes('INSERT INTO ai_costs'));
    expect(costInserts).toHaveLength(1);
    const costBound = costInserts[0].bound as unknown[];
    expect(costBound[4]).toBe('google/veo-3.1'); // model
    expect(costBound[5]).toBe(5);                // units (duration)
    expect(costBound[6]).toBe('seconds');         // unit_kind
  });

  it('marks asset failed and rethrows when AI returns no result.video', async () => {
    const db = fakeDB();
    const ai = { run: vi.fn(async () => ({ result: {} })) };
    const r2 = fakeR2();

    globalThis.fetch = ORIGINAL_FETCH;

    await expect(
      handleAiGenMessage(
        { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
        VALID_MESSAGE,
      ),
    ).rejects.toThrow(/AI video generation failed/);

    const failedUpdate = db.runs.find(
      (r) => r.sql.includes('UPDATE generated_assets') && r.bound[0] === 'failed',
    );
    expect(failedUpdate).toBeDefined();
  });

  it('marks asset failed and rethrows when the video fetch returns non-2xx', async () => {
    const db = fakeDB();
    const ai = fakeAI('https://r2.cf.example/veo.mp4');
    const r2 = fakeR2();

    globalThis.fetch = vi.fn(async () =>
      new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(
      handleAiGenMessage(
        { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
        VALID_MESSAGE,
      ),
    ).rejects.toThrow(/AI video generation failed/);

    const failedUpdate = db.runs.find(
      (r) => r.sql.includes('UPDATE generated_assets') && r.bound[0] === 'failed',
    );
    expect(failedUpdate).toBeDefined();
  });

  it('does NOT submit to Stream REST API when STREAM_ENABLED is unset', async () => {
    const db = fakeDB();
    const ai = fakeAI('https://r2.cf.example/veo.mp4');
    const r2 = fakeR2();
    const fetchSpy = vi.fn(async () =>
      new Response(new Uint8Array(4).buffer, { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await handleAiGenMessage(
      { AI: ai as unknown as AiVideoEnv['AI'], DB: db as unknown as D1Database, VIDEOS: r2 as unknown as R2Bucket },
      VALID_MESSAGE,
    );

    // Only one fetch call — the video download. No CF API call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('submits to Stream REST API when STREAM_ENABLED=true and returns stream_video_id', async () => {
    const db = fakeDB();
    const ai = fakeAI('https://r2.cf.example/veo.mp4');
    const r2 = fakeR2();

    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      callCount++;
      if (callCount === 1) {
        // Video download
        return new Response(new Uint8Array(8).buffer, { status: 200 });
      }
      // Stream API submission
      expect(String(url)).toContain('api.cloudflare.com');
      return new Response(JSON.stringify({ result: { uid: 'stream-xyz' } }), { status: 200 });
    }) as unknown as typeof fetch;

    await handleAiGenMessage(
      {
        AI: ai as unknown as AiVideoEnv['AI'],
        DB: db as unknown as D1Database,
        VIDEOS: r2 as unknown as R2Bucket,
        STREAM_ENABLED: 'true',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CF_STREAM_API_TOKEN: 'tok',
      },
      VALID_MESSAGE,
    );

    expect(callCount).toBe(2);
    const readyUpdate = db.runs.find(
      (r) => r.sql.includes('UPDATE generated_assets') && r.bound[0] === 'ready',
    );
    expect(readyUpdate?.bound[2]).toBe('stream-xyz'); // stream_video_id
  });
});
