import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AnimationProjectSpec } from './animation-scene-schema';

const validPlan = (): AnimationProjectSpec => ({
  version: 1,
  title: 'Launch',
  fps: 30,
  width: 1920,
  height: 1080,
  durationFrames: 450,
  background: { kind: 'solid', color: '#0a84ff' },
  scenes: [{
    id: 'scene-1',
    startFrame: 0,
    durationFrames: 450,
    layout: 'title',
    layers: [{
      kind: 'text',
      id: 'headline',
      startFrame: 0,
      durationFrames: 450,
      x: 160,
      y: 240,
      width: 1600,
      height: 240,
      text: 'Launch faster',
      fontSize: 88,
      fontWeight: 700,
      align: 'center',
      color: '#ffffff',
    }],
  }],
});

const planWithImagePlaceholder = (): AnimationProjectSpec => ({
  ...validPlan(),
  scenes: [{
    ...validPlan().scenes[0],
    layers: [
      validPlan().scenes[0].layers[0],
      {
        kind: 'image',
        id: 'hero',
        startFrame: 0,
        durationFrames: 450,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        assetId: 'asset:hero-1',
        fit: 'cover',
      },
      {
        kind: 'image',
        id: 'bg',
        startFrame: 0,
        durationFrames: 450,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        assetId: 'asset:background-1',
        fit: 'cover',
      },
    ],
  }],
});

const planWithTooManyPlaceholders = (): AnimationProjectSpec => ({
  ...validPlan(),
  scenes: [{
    ...validPlan().scenes[0],
    layers: [
      validPlan().scenes[0].layers[0],
      ...(['asset:hero-1', 'asset:hero-2', 'asset:hero-3', 'asset:hero-4', 'asset:hero-5'] as const).map((assetId, index) => ({
        kind: 'image' as const,
        id: `img-${index}`,
        startFrame: 0,
        durationFrames: 450,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        assetId,
        fit: 'cover' as const,
      })),
    ],
  }],
});

// durationFrames (900) deliberately disagrees with the scene coverage (450).
// The route should normalize durationFrames to the scene coverage instead of 502ing.
const planWithMismatchedDuration = (): AnimationProjectSpec => ({
  ...validPlan(),
  durationFrames: 900,
});

const planWithOwnedAsset = (): AnimationProjectSpec => ({
  ...validPlan(),
  scenes: [{
    ...validPlan().scenes[0],
    layers: [
      validPlan().scenes[0].layers[0],
      {
        kind: 'image',
        id: 'hero',
        startFrame: 0,
        durationFrames: 450,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        assetId: 'a_owned1234567890',
        fit: 'cover',
      },
    ],
  }],
});

let chatResults: unknown[] = [];
let chatCallCount = 0;

vi.mock('@tanstack/ai', async (orig) => {
  const actual = await orig<typeof import('@tanstack/ai')>();
  return {
    ...actual,
    chat: vi.fn(async () => {
      const result = chatResults[chatCallCount] ?? validPlan();
      chatCallCount++;
      return result;
    }),
    generateImage: vi.fn(async () => ({
      id: 'img1',
      model: '@cf/black-forest-labs/flux-1-schnell',
      images: [{ b64Json: btoa('imgbytes') }],
    })),
    generateSpeech: vi.fn(async () => ({ audio: btoa('mp3bytes') })),
  };
});

import { chat, generateImage, generateSpeech } from '@tanstack/ai';
import { studioAnimationRoutes } from './studio-animation';

type U = { id: string; emailVerified: boolean } | null;

function rejectingRateLimiter() {
  return {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => new Response(
        JSON.stringify({ allowed: false, remaining: 0, limit: 30, retryAfterMs: 1000, resetMs: 0 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    }),
  };
}

function makeDbStub(options: { ownedAssets?: Record<string, { r2Key: string; kind: 'image' | 'video' }> } = {}) {
  const batchCalls: Array<Array<Record<string, unknown>>> = [];
  const inserts: Array<{ sql: string; binds: unknown[] }> = [];
  const makeStmt = (sql: string, boundArgs: unknown[] = []): Record<string, unknown> => {
    const stmt: Record<string, unknown> = {};
    stmt['bind'] = (...args: unknown[]) => makeStmt(sql, args);
    stmt['run'] = vi.fn(async () => {
      inserts.push({ sql, binds: boundArgs });
      return {};
    });
    stmt['first'] = vi.fn(async () => {
      if (sql.includes('SUM(bytes)')) return { used: 100 };
      if (sql.includes('storage_bytes_quota')) return { quota: 5 * 1024 * 1024 * 1024 };
      if (sql.includes('FROM generated_assets')) {
        const [assetId, userId, kind] = boundArgs as [string, string, 'image' | 'video'];
        const owned = options.ownedAssets?.[assetId];
        if (owned && owned.kind === kind && userId === 'u1') {
          return { id: assetId, r2_key: owned.r2Key, kind: owned.kind };
        }
        return null;
      }
      return null;
    });
    stmt['sql'] = sql;
    stmt['_binds'] = boundArgs;
    return stmt;
  };
  const db: Record<string, unknown> = {};
  db['prepare'] = (sql: string) => makeStmt(sql);
  db['batch'] = vi.fn(async (stmts: unknown[]) => {
    batchCalls.push(stmts as Array<Record<string, unknown>>);
    return [];
  });
  db['_batchCalls'] = batchCalls;
  db['_inserts'] = inserts;
  return db;
}

function makeVideosStub() {
  const puts: Array<{ key: string }> = [];
  const videos: Record<string, unknown> = {};
  videos['put'] = vi.fn(async (key: string) => { puts.push({ key }); });
  videos['_puts'] = puts;
  return videos;
}

function stubContainer() {
  const calls: Array<{ body: unknown }> = [];
  const ns = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (_path: string, init?: RequestInit) => {
        calls.push({ body: init?.body ? JSON.parse(init.body as string) : null });
        return new Response('{}', { status: 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  (ns as unknown as { _calls: typeof calls })._calls = calls;
  return ns;
}

function buildApp(user: U, extra: Record<string, unknown> = {}, dbOptions?: Parameters<typeof makeDbStub>[0]) {
  const db = makeDbStub(dbOptions);
  const videos = makeVideosStub();
  const app = new Hono<{ Variables: { user: U } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', studioAnimationRoutes);
  const base = {
    AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => new ArrayBuffer(0) },
    DB: db,
    VIDEOS: videos,
    RENDER_CONTAINER: stubContainer(),
    RENDER_CALLBACK_SECRET: 'secret',
    VIDEO_ENCODING: { send: async () => {} },
    ...extra,
  };
  return { app, base, db, videos };
}

async function postAnimation(
  user: U,
  body: unknown,
  extra: Record<string, unknown> = {},
  dbOptions?: Parameters<typeof makeDbStub>[0],
) {
  const { app, base, db, videos } = buildApp(user, extra, dbOptions);
  const res = await app.request('/api/studio/animation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, base);
  return { res, db, videos, aiRun: vi.mocked(chat) };
}

const verifiedUser = { id: 'u1', emailVerified: true };
const unverifiedUser = { id: 'u1', emailVerified: false };

describe('POST /api/studio/animation gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatResults = [validPlan()];
    chatCallCount = 0;
  });

  it('401 when unauthenticated', async () => {
    expect((await postAnimation(null, { prompt: 'make an animation' })).res.status).toBe(401);
  });

  it('403 when email is not verified', async () => {
    expect((await postAnimation(unverifiedUser, { prompt: 'make an animation' })).res.status).toBe(403);
  });

  it('400 on invalid body', async () => {
    expect((await postAnimation(verifiedUser, { prompt: 'a'.repeat(2049) })).res.status).toBe(400);
  });

  it('429 when rate limited before model calls', async () => {
    const { res, aiRun } = await postAnimation(
      verifiedUser,
      { prompt: 'make an animation' },
      { RATE_LIMITER: rejectingRateLimiter() },
    );
    expect(res.status).toBe(429);
    expect(aiRun).not.toHaveBeenCalled();
  });
});

describe('POST /api/studio/animation success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatResults = [validPlan()];
    chatCallCount = 0;
  });

  it('returns 202 with jobId and dispatches spooool-animation render', async () => {
    const { app, base } = buildApp(verifiedUser);
    const res = await app.request('/api/studio/animation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'make an animation', durationSeconds: 15 }),
    }, base);
    expect(res.status).toBe(202);
    const body = await res.json() as {
      jobId: string;
      status: string;
      estimate: { durationSeconds: number; estimatedCostUsd: number };
      generatedAssetCount: number;
    };
    expect(body.status).toBe('queued');
    expect(body.jobId).toMatch(/^j_/);
    expect(body.estimate.durationSeconds).toBe(15);
    expect(body.generatedAssetCount).toBe(0);

    const calls = (base.RENDER_CONTAINER as unknown as { _calls: Array<{ body: { takeKeys: string[]; compositionProps: Record<string, unknown> } }> })._calls;
    expect(calls[0].body.takeKeys).toEqual([]);
    expect(calls[0].body.compositionProps.compositionId).toBe('spooool-animation');
    expect(calls[0].body.compositionProps.animation).toMatchObject({ width: 1920, height: 1080 });
    expect(calls[0].body.compositionProps.studio).toMatchObject({
      prompt: 'make an animation',
      style: 'clean',
      aspectRatio: '16:9',
      durationSeconds: 15,
      planHash: expect.any(String),
    });
  });

  it('502 when plan validation fails twice, with a validation detail surfaced', async () => {
    chatResults = [{ version: 1, scenes: [] }, { version: 1, scenes: [] }];
    const { res } = await postAnimation(verifiedUser, { prompt: 'make an animation' });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; detail?: string };
    expect(body.detail).toBeTruthy();
  });

  it('normalizes durationFrames to scene coverage instead of 502ing', async () => {
    chatResults = [planWithMismatchedDuration(), planWithMismatchedDuration()];
    const { app, base } = buildApp(verifiedUser);
    const res = await app.request('/api/studio/animation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'make an animation' }),
    }, base);
    expect(res.status).toBe(202);
    const calls = (base.RENDER_CONTAINER as unknown as { _calls: Array<{ body: { compositionProps: { animation: { durationFrames: number } } } }> })._calls;
    expect(calls[0].body.compositionProps.animation.durationFrames).toBe(450);
  });
});

describe('POST /api/studio/animation assets and voiceover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatResults = [validPlan()];
    chatCallCount = 0;
  });

  it('generates images when useGeneratedImages is true', async () => {
    chatResults = [planWithImagePlaceholder(), 'Short narration for the animation.'];
    const { res } = await postAnimation(verifiedUser, {
      prompt: 'make an animation',
      useGeneratedImages: true,
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { generatedAssetCount: number };
    expect(body.generatedAssetCount).toBe(2);
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(2);
  });

  it('generates TTS when voiceover is set', async () => {
    chatResults = [validPlan(), 'Short narration for the animation.'];
    const { app, base, videos } = buildApp(verifiedUser);
    const res = await app.request('/api/studio/animation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'make an animation', voiceover: 'warm' }),
    }, base);
    expect(res.status).toBe(202);
    expect(vi.mocked(generateSpeech)).toHaveBeenCalledTimes(1);
    const puts = (videos as unknown as { _puts: Array<{ key: string }> })._puts;
    expect(puts.some((p) => p.key.startsWith('recorder/tts/'))).toBe(true);

    const calls = (base.RENDER_CONTAINER as unknown as { _calls: Array<{ body: { compositionProps: { audio?: { r2Key: string } } } }> })._calls;
    expect(calls[0].body.compositionProps.audio?.r2Key).toMatch(/^recorder\/tts\//);
  });

  it('writes animation_plan and animation_render_estimate costs', async () => {
    const { db } = await postAnimation(verifiedUser, { prompt: 'make an animation' });
    const batchCalls = (db as unknown as { _batchCalls: Array<Array<Record<string, unknown>>> })._batchCalls;
    const ops = batchCalls.flatMap((batch) => batch.map((stmt) => {
      const sql = String(stmt['sql'] ?? '');
      const binds = (stmt['_binds'] as unknown[]) ?? [];
      return sql.includes('ai_costs') ? binds[2] : null;
    })).filter(Boolean);
    expect(ops).toContain('animation_plan');
    expect(ops).toContain('animation_render_estimate');
  });

  it('400 when more than four generated image placeholders are requested', async () => {
    chatResults = [planWithTooManyPlaceholders()];
    const { res } = await postAnimation(verifiedUser, {
      prompt: 'make an animation',
      useGeneratedImages: true,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/At most 4 generated images/);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });

  it('403 when the plan references an asset not owned by the user', async () => {
    chatResults = [planWithOwnedAsset()];
    const { res } = await postAnimation(verifiedUser, { prompt: 'make an animation' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not available/);
  });

  it('dispatches owned ready assets referenced in the plan', async () => {
    chatResults = [planWithOwnedAsset()];
    const { app, base } = buildApp(verifiedUser, {}, {
      ownedAssets: {
        a_owned1234567890: { r2Key: 'studio/images/a_owned1234567890.jpg', kind: 'image' },
      },
    });
    const res = await app.request('/api/studio/animation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'make an animation' }),
    }, base);
    expect(res.status).toBe(202);
    const calls = (base.RENDER_CONTAINER as unknown as { _calls: Array<{ body: { compositionProps: { assets: Array<{ assetId: string; r2Key: string }> } } }> })._calls;
    expect(calls[0].body.compositionProps.assets).toEqual([{
      assetId: 'a_owned1234567890',
      r2Key: 'studio/images/a_owned1234567890.jpg',
      kind: 'image',
    }]);
  });
});
