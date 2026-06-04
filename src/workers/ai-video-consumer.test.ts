import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleAiGenMessage, type AiGenEnv } from './ai-video-consumer';

function makeDb(overrides: Partial<{ run: () => void; first: () => unknown }> = {}) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue(undefined),
    first: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    _stmt: stmt,
  };
}

function makeAI(resultOverride?: unknown) {
  const defaultResult = { result: { video: 'https://r2.cf.example/veo/out.mp4' } };
  return {
    run: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(resultOverride ?? defaultResult), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  };
}

function makeVideos() {
  return { put: vi.fn().mockResolvedValue(undefined) };
}

function makeEnv(overrides: Partial<AiGenEnv> = {}): AiGenEnv {
  return {
    DB: makeDb() as unknown as D1Database,
    AI: makeAI() as unknown as AiGenEnv['AI'],
    VIDEOS: makeVideos() as unknown as R2Bucket,
    ...overrides,
  };
}

const VALID_BODY = {
  assetId: 'asset-1',
  userId: 'user-1',
  prompt: 'A sunset over the mountains',
  duration: 5,
};

describe('handleAiGenMessage', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => 'cost-uuid-1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Uint8Array(1024 * 100), { status: 200 }),
    ));
  });

  it('drops messages with invalid body silently', async () => {
    const env = makeEnv();
    await handleAiGenMessage(env, { bad: 'payload' });
    expect((env.DB as unknown as ReturnType<typeof makeDb>).prepare).not.toHaveBeenCalled();
  });

  it('marks status=processing then status=ready on success', async () => {
    const env = makeEnv();
    const db = env.DB as unknown as ReturnType<typeof makeDb>;

    await handleAiGenMessage(env, VALID_BODY);

    const calls = db.prepare.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("status='processing'"))).toBe(true);
    expect(calls.some((s: string) => s.includes("status='ready'"))).toBe(true);
  });

  it('calls env.AI.run with google/veo-3.1 and gateway id x', async () => {
    const env = makeEnv();
    await handleAiGenMessage(env, VALID_BODY);

    expect(env.AI.run).toHaveBeenCalledWith(
      'google/veo-3.1',
      expect.objectContaining({ prompt: 'A sunset over the mountains', duration: 5 }),
      { gateway: { id: 'x' } },
    );
  });

  it('puts video bytes to R2 at studio/video/<assetId>.mp4', async () => {
    const env = makeEnv();
    await handleAiGenMessage(env, VALID_BODY);

    expect(env.VIDEOS.put).toHaveBeenCalledWith(
      'studio/video/asset-1.mp4',
      expect.any(ArrayBuffer),
      { httpMetadata: { contentType: 'video/mp4' } },
    );
  });

  it('inserts an ai_costs row with unit_kind=seconds', async () => {
    const env = makeEnv();
    const db = env.DB as unknown as ReturnType<typeof makeDb>;

    await handleAiGenMessage(env, VALID_BODY);

    const costCall = db.prepare.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO ai_costs'),
    );
    expect(costCall).toBeDefined();
    const bindArgs = db._stmt.bind.mock.calls.find(
      (_: unknown, i: number) => db.prepare.mock.calls[i]?.[0]?.includes('INSERT INTO ai_costs'),
    );
    // verify unit_kind=seconds is in the INSERT (positional: id, user_id, op, route, model, units, unit_kind...)
    const allStmts = db.prepare.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(allStmts.some((s: string) => s.includes('INSERT INTO ai_costs'))).toBe(true);
    // The bound values for the cost row include 'seconds' as unit_kind
    const bindCalls: unknown[][] = db._stmt.bind.mock.calls;
    const secondsRow = bindCalls.find((args) => args.includes('seconds'));
    expect(secondsRow).toBeDefined();
  });

  it('marks status=failed and re-throws on AI error so queue retries', async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error('Veo quota exceeded')) };
    const env = makeEnv({ AI: ai as unknown as AiGenEnv['AI'] });
    const db = env.DB as unknown as ReturnType<typeof makeDb>;

    await expect(handleAiGenMessage(env, VALID_BODY)).rejects.toThrow('Veo quota exceeded');

    const calls = db.prepare.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("status='failed'"))).toBe(true);
  });

  it('marks status=failed when result.video is absent', async () => {
    const ai = makeAI({ result: {} });
    const env = makeEnv({ AI: ai as unknown as AiGenEnv['AI'] });
    const db = env.DB as unknown as ReturnType<typeof makeDb>;

    await expect(handleAiGenMessage(env, VALID_BODY)).rejects.toThrow();

    const calls = db.prepare.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("status='failed'"))).toBe(true);
  });

  it('still marks ready when Stream ingest is disabled (no STREAM_ENABLED)', async () => {
    const env = makeEnv({ STREAM_ENABLED: undefined });
    await handleAiGenMessage(env, VALID_BODY);

    const db = env.DB as unknown as ReturnType<typeof makeDb>;
    const calls = db.prepare.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("status='ready'"))).toBe(true);
    // stream_video_id should be null (no Stream call)
    const readyBind = db._stmt.bind.mock.calls.find(
      (args: unknown[]) => args.includes('studio/video/asset-1.mp4'),
    );
    expect(readyBind).toBeDefined();
    expect(readyBind).toContain(null); // stream_video_id=null
  });
});
