import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@tanstack/ai', async (orig) => {
  const actual = await orig<typeof import('@tanstack/ai')>();
  return {
    ...actual,
    chat: vi.fn(() => (async function* () {
      yield { type: 'RUN_STARTED', runId: 'r1' };
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi there' };
      yield { type: 'RUN_FINISHED', runId: 'r1' };
    })()),
    generateImage: vi.fn(async () => ({
      id: 'img1',
      model: '@cf/black-forest-labs/flux-1-schnell',
      images: [{ b64Json: btoa('hello') }],
    })),
    generateTranscription: vi.fn(async () => ({
      text: 'hello world',
      segments: [{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'world' }],
    })),
  };
});

import { generateImage, chat } from '@tanstack/ai';
import { studioRoutes } from './studio';

// Convenience alias — vi.mocked gives us typed access to the mock
const mockGenerateImage = vi.mocked(generateImage);

// ────────────────────────────────────────────────────────────
// Chat harness (unchanged)
// ────────────────────────────────────────────────────────────
type U = { id: string; email: string; name: string; emailVerified: boolean } | null;
function harness(user: U, env: Record<string, unknown> = {}) {
  const app = new Hono<{ Variables: { user: U } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', studioRoutes);
  const base = { AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => ({}) }, ...env };
  return (body: unknown) => app.request('/api/studio/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, base);
}
const okBody = { messages: [{ role: 'user', content: 'help me name my video' }] };

// ────────────────────────────────────────────────────────────
// Image harness helpers
// ────────────────────────────────────────────────────────────
function makeDbStub(overrides: Record<string, unknown> = {}) {
  const batchCalls: Array<Array<unknown>> = [];

  // makeStmt records bound args on the statement object so tests can assert them
  // after DB.batch is called (the batch stub stores statement objects, not results).
  const makeStmt = (sql: string, boundArgs: unknown[] = []): Record<string, unknown> => {
    const stmt: Record<string, unknown> = {};
    // Each .bind() call returns a new statement copy that carries the bound args.
    stmt['bind'] = (...args: unknown[]) => makeStmt(sql, args);
    stmt['run'] = vi.fn(async () => ({}));
    stmt['first'] = vi.fn(async () => {
      if (sql.includes('SUM(bytes)')) return { used: 100 };
      if (sql.includes('storage_bytes_quota')) return { quota: 5 * 1024 * 1024 * 1024 };
      if (sql.includes('FROM videos WHERE id')) return (overrides['videoRow'] as unknown) ?? null;
      if (sql.includes('FROM generated_assets WHERE id')) return (overrides['assetRow'] as unknown) ?? null;
      if (sql.includes('FROM ai_costs')) return (overrides['aiCostsCount'] as unknown) ?? { n: 0 };
      return null;
    });
    stmt['sql'] = sql;
    stmt['_binds'] = boundArgs;  // recorded for test assertions
    return stmt;
  };

  const db: Record<string, unknown> = {};
  db['prepare'] = (sql: string) => makeStmt(sql);
  db['batch'] = vi.fn(async (stmts: unknown[]) => {
    batchCalls.push(stmts);
    return [];
  });
  db['_batchCalls'] = batchCalls;
  return db;
}

function makeVideosStub() {
  const puts: Array<{ key: string; body: unknown; contentType: string | undefined }> = [];
  let getResult: unknown = null;

  const videos: Record<string, unknown> = {};
  videos['put'] = vi.fn(async (key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) => {
    puts.push({ key, body, contentType: opts?.httpMetadata?.contentType });
  });
  videos['get'] = vi.fn(async (_key: string) => getResult);
  videos['_puts'] = puts;
  videos['_setGetResult'] = (v: unknown) => { getResult = v; };
  return videos;
}

function buildApp(user: U, db: Record<string, unknown>, videos: Record<string, unknown>, extraEnv: Record<string, unknown> = {}) {
  const app = new Hono<{ Variables: { user: U } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', studioRoutes);
  const base = {
    AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => ({}) },
    DB: db,
    VIDEOS: videos,
    ...extraEnv,
  };
  return { app, base };
}

const verifiedUser = { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true };
const unverifiedUser = { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: false };

// ────────────────────────────────────────────────────────────
// Chat tests (existing — must stay green)
// ────────────────────────────────────────────────────────────
describe('POST /api/studio/chat', () => {
  beforeEach(() => vi.clearAllMocks());
  it('401 when unauthenticated', async () => { expect((await harness(null)(okBody)).status).toBe(401); });
  it('403 when email not verified', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: false })(okBody);
    expect(r.status).toBe(403);
  });
  it('streams SSE for a verified user', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true })(okBody);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await r.text();
    expect(text).toContain('data:');
    expect(text).toContain('hi there');
    expect(text).toContain('RUN_FINISHED');
  });
  it('400 on invalid body (no messages)', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true })({});
    expect(r.status).toBe(400);
  });
  it('429 when rate-limited (gate runs before chat())', async () => {
    const RATE_LIMITER = {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => new Response(
          JSON.stringify({ allowed: false, remaining: 0, limit: 30, retryAfterMs: 1000, resetMs: 0 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      }),
    };
    const r = await harness(
      { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true },
      { RATE_LIMITER },
    )(okBody);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────
// Image generation tests
// ────────────────────────────────────────────────────────────
describe('POST /api/studio/image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateImage.mockResolvedValue({
      id: 'img1',
      model: '@cf/black-forest-labs/flux-1-schnell',
      images: [{ b64Json: btoa('hello') }],
    } as Awaited<ReturnType<typeof generateImage>>);
  });

  const post = (user: U, body: unknown, extraEnv: Record<string, unknown> = {}) => {
    const db = makeDbStub();
    const videos = makeVideosStub();
    const { app, base } = buildApp(user, db, videos, extraEnv);
    const r = app.request('http://localhost/api/studio/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, base);
    return { r, db, videos };
  };

  it('401 when unauthenticated', async () => {
    expect((await post(null, { prompt: 'a dog' }).r).status).toBe(401);
  });

  it('403 when email not verified', async () => {
    expect((await post(unverifiedUser, { prompt: 'a dog' }).r).status).toBe(403);
  });

  it('429 when rate-limited', async () => {
    const RATE_LIMITER = {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => new Response(
          JSON.stringify({ allowed: false, remaining: 0, limit: 30, retryAfterMs: 1000, resetMs: 0 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      }),
    };
    const { r } = post(verifiedUser, { prompt: 'a dog' }, { RATE_LIMITER });
    const res = await r;
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('429 when daily gen cap reached', async () => {
    const db = makeDbStub({ aiCostsCount: { n: 50 } });
    const videos = makeVideosStub();
    const { app, base } = buildApp(verifiedUser, db, videos);
    const r = await app.request('http://localhost/api/studio/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a dog' }),
    }, base);
    expect(r.status).toBe(429);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.error as string).toContain('Daily generation limit');
  });

  it('400 on missing prompt', async () => {
    expect((await post(verifiedUser, {}).r).status).toBe(400);
  });

  it('400 on empty prompt', async () => {
    expect((await post(verifiedUser, { prompt: '' }).r).status).toBe(400);
  });

  it('400 on prompt exceeding 2048 chars', async () => {
    expect((await post(verifiedUser, { prompt: 'a'.repeat(2049) }).r).status).toBe(400);
  });

  it('201 happy path — shape, r2Key, contentType, bytes, dataUrl, DB inserts', async () => {
    const db = makeDbStub();
    const videos = makeVideosStub();
    const { app, base } = buildApp(verifiedUser, db, videos);
    const r = await app.request('http://localhost/api/studio/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a sunset' }),
    }, base);

    expect(r.status).toBe(201);
    const body = await r.json() as Record<string, unknown>;

    // assetId format
    expect(typeof body.assetId).toBe('string');
    expect(body.assetId).toMatch(/^a_[0-9a-f]{16}$/);

    // r2Key pattern
    expect(body.r2Key).toMatch(/^studio\/images\/a_[0-9a-f]{16}\.jpg$/);

    // bytes = length of 'hello' = 5
    expect(body.bytes).toBe(5);

    // dataUrl starts correctly and round-trips back to 'hello'
    const dataUrl = body.dataUrl as string;
    expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    const b64Part = dataUrl.replace('data:image/jpeg;base64,', '');
    expect(atob(b64Part)).toBe('hello');

    // VIDEOS.put received exactly 1 call with correct key + contentType
    const puts = videos['_puts'] as Array<{ key: string; body: unknown; contentType: string | undefined }>;
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^studio\/images\/a_[0-9a-f]{16}\.jpg$/);
    expect(puts[0].contentType).toBe('image/jpeg');

    // The bytes written to VIDEOS.put decode back to 'hello' — proves direct atob, not JSON.parse
    const writtenBytes = puts[0].body as Uint8Array;
    expect(writtenBytes).toBeInstanceOf(Uint8Array);
    const decoded = Array.from(writtenBytes).map((b) => String.fromCharCode(b)).join('');
    expect(decoded).toBe('hello');

    // DB.batch called with exactly 2 statements
    const batchFn = db['batch'] as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledTimes(1);
    const stmts = (db['_batchCalls'] as Array<Array<unknown>>)[0];
    expect(stmts).toHaveLength(2);

    // Verify the SQL content by checking the sql fields on the statement objects
    const stmt0 = stmts[0] as Record<string, unknown>;
    const stmt1 = stmts[1] as Record<string, unknown>;
    expect(String(stmt0['sql'] ?? '')).toContain('INSERT INTO generated_assets');
    expect(String(stmt1['sql'] ?? '')).toContain('INSERT INTO ai_costs');

    // Assert the ai_costs bound values so a typo in EST_USD_PER_IMAGE or a units
    // swap would not ship silently with green tests.
    // Bind order from aiCostStatement: id(0), userId(1), op(2), route(3), model(4),
    //                                  units(5), unitKind(6), estUsd(7), projectId(8), createdAt(9)
    const aiCostBinds = stmt1['_binds'] as unknown[];
    expect(aiCostBinds[1]).toBe('u1');                                        // userId
    expect(aiCostBinds[2]).toBe('image_gen');                                  // op
    expect(aiCostBinds[4]).toBe('@cf/black-forest-labs/flux-1-schnell');       // model (IMAGE_MODEL)
    expect(aiCostBinds[5]).toBe(1);                                            // units
    expect(aiCostBinds[6]).toBe('images');                                     // unitKind
    expect(aiCostBinds[7]).toBe(0.0013);                                       // estUsd (EST_USD_PER_IMAGE)
  });

  it('413 when storage quota exceeded — no VIDEOS.put, no DB.batch', async () => {
    // Override DB so SUM(bytes) returns a value that exceeds quota
    const db = makeDbStub();
    const origPrepare = db['prepare'] as (sql: string) => Record<string, unknown>;
    (db['prepare'] as unknown) = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('SUM(bytes)')) {
        return {
          bind: (..._args: unknown[]) => ({
            first: vi.fn(async () => ({ used: 5 * 1024 * 1024 * 1024 + 1 })),
          }),
        };
      }
      if (sql.includes('storage_bytes_quota')) {
        return {
          bind: (..._args: unknown[]) => ({
            first: vi.fn(async () => ({ quota: 5 * 1024 * 1024 * 1024 })),
          }),
        };
      }
      return stmt;
    };

    const videos = makeVideosStub();
    const { app, base } = buildApp(verifiedUser, db, videos);
    const r = await app.request('http://localhost/api/studio/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    }, base);

    expect(r.status).toBe(413);
    const body = await r.json() as Record<string, unknown>;
    expect(body.code).toBe('storage_quota_exceeded');

    const putFn = videos['put'] as ReturnType<typeof vi.fn>;
    const batchFn = db['batch'] as ReturnType<typeof vi.fn>;
    expect(putFn).not.toHaveBeenCalled();
    expect(batchFn).not.toHaveBeenCalled();
  });

  it('502 when generateImage returns no b64Json (url-only response)', async () => {
    mockGenerateImage.mockResolvedValue({
      id: 'img1',
      model: '@cf/black-forest-labs/flux-1-schnell',
      images: [{ url: 'http://x' }],
    } as Awaited<ReturnType<typeof generateImage>>);

    const db = makeDbStub();
    const videos = makeVideosStub();
    const { app, base } = buildApp(verifiedUser, db, videos);
    const r = await app.request('http://localhost/api/studio/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a dog' }),
    }, base);

    expect(r.status).toBe(502);
    const putFn = videos['put'] as ReturnType<typeof vi.fn>;
    const batchFn = db['batch'] as ReturnType<typeof vi.fn>;
    expect(putFn).not.toHaveBeenCalled();
    expect(batchFn).not.toHaveBeenCalled();
  });

  it('502 when generateImage throws', async () => {
    mockGenerateImage.mockRejectedValue(new Error('model unavailable'));
    const db = makeDbStub();
    const videos = makeVideosStub();
    const { app, base } = buildApp(verifiedUser, db, videos);
    const r = await app.request('http://localhost/api/studio/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a dog' }),
    }, base);

    expect(r.status).toBe(502);
    const body = await r.json() as Record<string, unknown>;
    expect(body.detail as string).toContain('model unavailable');
  });
});

// ────────────────────────────────────────────────────────────
// Video generation tests (POST /api/studio/video)
// ────────────────────────────────────────────────────────────
describe('POST /api/studio/video', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeAiGenStub() {
    const sends: Array<unknown> = [];
    return {
      send: vi.fn(async (msg: unknown) => { sends.push(msg); }),
      _sends: sends,
    };
  }

  function makeVideoDbStub() {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];

    const makeStmt = (sql: string) => {
      let boundValues: unknown[] = [];
      const stmt: Record<string, unknown> = {
        sql,
        bind: (...args: unknown[]) => { boundValues = args; return stmt; },
        run: vi.fn(async () => { runs.push({ sql, binds: [...boundValues] }); return {}; }),
        first: vi.fn(async () => {
          if (sql.includes('SUM(bytes)')) return { used: 0 };
          if (sql.includes('storage_bytes_quota')) return { quota: 5 * 1024 * 1024 * 1024 };
          if (sql.includes('FROM ai_costs')) return { n: 0 };
          return null;
        }),
      };
      return stmt;
    };

    const db: Record<string, unknown> = {
      prepare: (sql: string) => makeStmt(sql),
      batch: vi.fn(async () => []),
      _runs: runs,
    };
    return db;
  }

  function postVideo(user: U, body: unknown, extraEnv: Record<string, unknown> = {}) {
    const db = makeVideoDbStub();
    const videos = makeVideosStub();
    const aiGen = makeAiGenStub();
    const { app, base } = buildApp(user, db, videos, { AI_GEN: aiGen, ...extraEnv });
    const r = app.request('http://localhost/api/studio/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, base);
    return { r, db, aiGen };
  }

  it('401 when unauthenticated', async () => {
    expect((await postVideo(null, { prompt: 'a rocket launch' }).r).status).toBe(401);
  });

  it('403 when email not verified', async () => {
    expect((await postVideo(unverifiedUser, { prompt: 'a rocket launch' }).r).status).toBe(403);
  });

  it('429 when rate-limited', async () => {
    const RATE_LIMITER = {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => new Response(
          JSON.stringify({ allowed: false, remaining: 0, limit: 30, retryAfterMs: 1000, resetMs: 0 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      }),
    };
    const { r } = postVideo(verifiedUser, { prompt: 'a rocket launch' }, { RATE_LIMITER });
    const res = await r;
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('429 when daily gen cap reached', async () => {
    function makeVideoDbStubAtCap() {
      const runs: Array<{ sql: string; binds: unknown[] }> = [];
      const makeStmt = (sql: string) => {
        let boundValues: unknown[] = [];
        const stmt: Record<string, unknown> = {
          sql,
          bind: (...args: unknown[]) => { boundValues = args; return stmt; },
          run: vi.fn(async () => { runs.push({ sql, binds: [...boundValues] }); return {}; }),
          first: vi.fn(async () => {
            if (sql.includes('SUM(bytes)')) return { used: 0 };
            if (sql.includes('storage_bytes_quota')) return { quota: 5 * 1024 * 1024 * 1024 };
            if (sql.includes('FROM ai_costs')) return { n: 50 };
            return null;
          }),
        };
        return stmt;
      };
      return { prepare: (sql: string) => makeStmt(sql), _runs: runs };
    }
    const db = makeVideoDbStubAtCap();
    const videos = makeVideosStub();
    const aiGen = makeAiGenStub();
    const { app, base } = buildApp(verifiedUser, db, videos, { AI_GEN: aiGen });
    const r = await app.request('http://localhost/api/studio/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a rocket launch' }),
    }, base);
    expect(r.status).toBe(429);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.error as string).toContain('Daily generation limit');
  });

  it('400 on missing prompt', async () => {
    expect((await postVideo(verifiedUser, {}).r).status).toBe(400);
  });

  it('400 on empty prompt', async () => {
    expect((await postVideo(verifiedUser, { prompt: '' }).r).status).toBe(400);
  });

  it('400 on prompt exceeding 2048 chars', async () => {
    expect((await postVideo(verifiedUser, { prompt: 'a'.repeat(2049) }).r).status).toBe(400);
  });

  it('503 when AI_GEN binding is absent — no generated_assets INSERT', async () => {
    // Build env without AI_GEN so the guard fires before any DB write.
    const db = makeVideoDbStub();
    const videos = makeVideosStub();
    const { app, base } = buildApp(verifiedUser, db, videos, {}); // no AI_GEN key
    const res = await app.request('http://localhost/api/studio/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a rocket launch' }),
    }, base);

    expect(res.status).toBe(503);

    // No INSERT should have been executed
    const runs = (db as Record<string, unknown>)['_runs'] as Array<{ sql: string }>;
    expect(runs.find((r) => r.sql.includes('INSERT INTO generated_assets'))).toBeUndefined();
  });

  it('503 when AI_GEN.send rejects — row is updated to failed', async () => {
    const db = makeVideoDbStub();
    const videos = makeVideosStub();
    const failingAiGen = {
      send: vi.fn(async () => { throw new Error('queue full'); }),
      _sends: [] as unknown[],
    };
    const { app, base } = buildApp(verifiedUser, db, videos, { AI_GEN: failingAiGen });
    const res = await app.request('http://localhost/api/studio/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a rocket launch' }),
    }, base);

    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string');

    // The INSERT ran first, then the failure UPDATE ran
    const runs = (db as Record<string, unknown>)['_runs'] as Array<{ sql: string }>;
    expect(runs.find((r) => r.sql.includes('INSERT INTO generated_assets'))).toBeDefined();
    const failUpdate = runs.find((r) => r.sql.includes("status='failed'"));
    expect(failUpdate).toBeDefined();
  });

  it('202 happy path — response shape, generated_assets INSERT, AI_GEN.send', async () => {
    const { r, db, aiGen } = postVideo(verifiedUser, { prompt: 'a waterfall in slow motion' });
    const res = await r;
    expect(res.status).toBe(202);

    const body = await res.json() as Record<string, unknown>;

    // Response shape
    expect(typeof body.assetId).toBe('string');
    expect(body.assetId).toMatch(/^a_[0-9a-f]{16}$/);
    expect(body.status).toBe('queued');

    // generated_assets INSERT
    // SQL literals: kind='video', source='video_gen' (not bind params).
    // Bind order: [0]=assetId, [1]=userId, [2]=spec_json, [3]=created_at, [4]=updated_at
    const runs = (db as Record<string, unknown>)['_runs'] as Array<{ sql: string; binds: unknown[] }>;
    const insertRun = runs.find((r) => r.sql.includes('INSERT INTO generated_assets'));
    expect(insertRun).toBeDefined();
    // SQL contains the literal kind/source values
    expect(insertRun!.sql).toContain("'video'");
    expect(insertRun!.sql).toContain("'video_gen'");
    expect(insertRun!.sql).toContain("'queued'");
    expect(insertRun!.binds[0]).toMatch(/^a_[0-9a-f]{16}$/); // assetId
    expect(insertRun!.binds[1]).toBe('u1');                   // userId
    // spec_json is at index 2
    const specJson = insertRun!.binds[2] as string;
    const spec = JSON.parse(specJson) as Record<string, unknown>;
    expect(spec.model).toBe('google/veo-3.1');
    expect(spec.prompt).toBe('a waterfall in slow motion');

    // AI_GEN.send called with correct payload
    expect(aiGen.send).toHaveBeenCalledTimes(1);
    const sent = aiGen._sends[0] as Record<string, unknown>;
    expect(sent.assetId).toBe(body.assetId);
    expect(sent.userId).toBe('u1');
    expect(sent.prompt).toBe('a waterfall in slow motion');
  });
});

// ────────────────────────────────────────────────────────────
// from-asset (set generated image as thumbnail)
// ────────────────────────────────────────────────────────────
describe('POST /api/videos/:id/thumbnail/from-asset', () => {
  beforeEach(() => vi.clearAllMocks());

  const postFromAsset = (
    user: U,
    videoId: string,
    body: unknown,
    dbOverrides: Record<string, unknown> = {},
    videosGetResult: unknown = null,
    origin = 'http://localhost',
  ) => {
    const db = makeDbStub(dbOverrides);
    const videos = makeVideosStub();
    (videos['_setGetResult'] as (v: unknown) => void)(videosGetResult);

    // Intercept the UPDATE so we can capture the bound thumbnail_url
    let capturedThumbnailUrl: string | null = null;
    const origPrepare = db['prepare'] as (sql: string) => Record<string, unknown>;
    (db['prepare'] as unknown) = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('UPDATE videos SET thumbnail_url')) {
        return {
          bind: (...args: unknown[]) => {
            capturedThumbnailUrl = args[0] as string;
            return { run: vi.fn(async () => ({})) };
          },
        };
      }
      return stmt;
    };

    const { app, base } = buildApp(user, db, videos);
    const r = app.request(`${origin}/api/videos/${videoId}/thumbnail/from-asset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, base);
    return { r, db, videos, getCapturedUrl: () => capturedThumbnailUrl };
  };

  it('401 when unauthenticated', async () => {
    const { r } = postFromAsset(null, 'v1', { asset_id: 'a1' });
    expect((await r).status).toBe(401);
  });

  it('403 when email not verified', async () => {
    const { r } = postFromAsset(
      { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: false },
      'v1',
      { asset_id: 'a1' },
    );
    expect((await r).status).toBe(403);
  });

  it('400 on invalid body (missing asset_id)', async () => {
    const { r } = postFromAsset(
      verifiedUser, 'v1', {},
      { videoRow: { id: 'v1', user_id: 'u1' }, assetRow: { id: 'a1', r2_key: 'studio/images/a1.jpg' } },
    );
    expect((await r).status).toBe(400);
  });

  it('404 when video not found', async () => {
    const { r } = postFromAsset(verifiedUser, 'v999', { asset_id: 'a1' }, { videoRow: null });
    expect((await r).status).toBe(404);
  });

  it('403 when video owned by another user', async () => {
    const { r } = postFromAsset(
      verifiedUser, 'v1', { asset_id: 'a1' },
      { videoRow: { id: 'v1', user_id: 'other' } },
    );
    expect((await r).status).toBe(403);
  });

  it('404 when asset not found or not owned', async () => {
    const { r } = postFromAsset(
      verifiedUser, 'v1', { asset_id: 'a_missing' },
      { videoRow: { id: 'v1', user_id: 'u1' }, assetRow: null },
    );
    expect((await r).status).toBe(404);
  });

  it('404 when asset R2 object missing', async () => {
    const { r } = postFromAsset(
      verifiedUser, 'v1', { asset_id: 'a1' },
      { videoRow: { id: 'v1', user_id: 'u1' }, assetRow: { id: 'a1', r2_key: 'studio/images/a1.jpg' } },
      null, // VIDEOS.get returns null → 404
    );
    expect((await r).status).toBe(404);
  });

  it('happy path: copies to thumbnails namespace, builds absolute URL, updates videos row', async () => {
    const fakeBody = new ReadableStream();
    const { r, videos, getCapturedUrl } = postFromAsset(
      verifiedUser, 'v1', { asset_id: 'a1' },
      { videoRow: { id: 'v1', user_id: 'u1' }, assetRow: { id: 'a1', r2_key: 'studio/images/a1.jpg' } },
      { body: fakeBody }, // VIDEOS.get returns object with body
      'http://localhost',
    );

    const res = await r;
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe('v1');

    const thumbnailUrl = body.thumbnail_url as string;

    // Must be absolute URL matching the thumbnail serve route
    expect(thumbnailUrl).toMatch(/^https?:\/\/[^/]+\/api\/thumbnails\/u1\/v1\//);
    expect(thumbnailUrl).toMatch(/[0-9a-f-]{36}\.jpg$/);

    // Response thumbnail_url must equal what was written to DB
    expect(getCapturedUrl()).toBe(thumbnailUrl);

    // VIDEOS.put wrote to the thumbnails prefix with correct contentType
    const puts = videos['_puts'] as Array<{ key: string; body: unknown; contentType: string | undefined }>;
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^thumbnails\/u1\/v1\/[0-9a-f-]{36}\.jpg$/);
    expect(puts[0].contentType).toBe('image/jpeg');

    // The put key's filename part matches the URL's filename part
    const urlFilename = thumbnailUrl.split('/').pop();
    const r2Filename = puts[0].key.split('/').pop();
    expect(urlFilename).toBe(r2Filename);
  });
});

describe('POST /api/studio/captions (ALO-648)', () => {
  const captionsUser = { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true };

  function postCaptions(user: typeof captionsUser | null, body: unknown, envOverrides: Record<string, unknown> = {}) {
    const db = makeDbStub({
      videoRow: { id: 'v1', user_id: 'u1', r2_key: 'u1/v1/raw.mp4', title: 'My video' },
    });
    const videos = makeVideosStub();
    (videos['_setGetResult'] as (v: unknown) => void)({
      body: new Uint8Array([1, 2, 3]),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      httpMetadata: { contentType: 'video/mp4' },
    });
    const app = new Hono<{ Variables: { user: typeof captionsUser | null } }>();
    app.use('*', async (c, next) => { c.set('user', user); await next(); });
    app.route('/', studioRoutes);
    const base = {
      AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => ({}) },
      DB: db,
      VIDEOS: videos,
      RATE_LIMITER: undefined,
      ...envOverrides,
    };
    return app.request('/api/studio/captions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, base);
  }

  it('returns 401 without a session', async () => {
    expect((await postCaptions(null, { videoId: 'v1' })).status).toBe(401);
  });

  it('maps transcription segments to CaptionCue[] and persists generated_assets', async () => {
    const res = await postCaptions(captionsUser, { videoId: 'v1' });
    expect(res.status).toBe(201);
    const body = await res.json() as { assetId: string; cues: Array<{ startFrames: number; endFrames: number; text: string }> };
    expect(body.cues).toEqual([
      { startFrames: 0, endFrames: 30, text: 'hello' },
      { startFrames: 30, endFrames: 60, text: 'world' },
    ]);
    expect(body.assetId).toMatch(/^a_/);
  });
});

// ────────────────────────────────────────────────────────────
// Metadata tests (ALO-649)
// ────────────────────────────────────────────────────────────
describe('POST /api/studio/metadata (ALO-649)', () => {
  const metadataUser = { id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true };

  const SAMPLE_METADATA = {
    title: 'How to Build a Video Platform',
    description: 'A concise guide to building a video platform on Cloudflare.',
    tags: ['cloudflare', 'video', 'workers'],
    chapters: [{ startSeconds: 0, title: 'Introduction' }],
  };

  const mockChat = vi.mocked(chat);

  function postMetadata(
    user: typeof metadataUser | null,
    body: unknown,
    dbOverrides: Record<string, unknown> = {},
  ) {
    const db = makeDbStub({ videoRow: { id: 'v1', user_id: 'u1', title: 'My video', description: 'Cool video' }, ...dbOverrides });
    const videos = makeVideosStub();
    const app = new Hono<{ Variables: { user: typeof metadataUser | null } }>();
    app.use('*', async (c, next) => { c.set('user', user); await next(); });
    app.route('/', studioRoutes);
    const base = {
      AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => ({}) },
      DB: db,
      VIDEOS: videos,
      RATE_LIMITER: undefined,
    };
    return { res: app.request('/api/studio/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, base), db };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: chat resolves to SAMPLE_METADATA when called with outputSchema.
    mockChat.mockResolvedValue(SAMPLE_METADATA as unknown as never);
  });

  it('returns 401 without a session', async () => {
    const { res } = postMetadata(null, { videoId: 'v1' });
    expect((await res).status).toBe(401);
  });

  it('returns 403 when email not verified', async () => {
    const { res } = postMetadata({ ...metadataUser, emailVerified: false }, { videoId: 'v1' });
    expect((await res).status).toBe(403);
  });

  it('returns 400 on invalid body (missing videoId)', async () => {
    const { res } = postMetadata(metadataUser, {});
    expect((await res).status).toBe(400);
  });

  it('returns 404 when video is not found', async () => {
    const { res } = postMetadata(metadataUser, { videoId: 'missing' }, { videoRow: null });
    expect((await res).status).toBe(404);
  });

  it('returns 403 when video belongs to another user', async () => {
    const { res } = postMetadata(
      { ...metadataUser, id: 'u_other' },
      { videoId: 'v1' },
    );
    // The video row has user_id='u1'; the requester is 'u_other'
    expect((await res).status).toBe(403);
  });

  it('returns 201 with structured metadata and stores generated_asset + ai_cost', async () => {
    const { res, db } = postMetadata(metadataUser, { videoId: 'v1' });
    const response = await res;
    expect(response.status).toBe(201);

    const body = await response.json() as { assetId: string; title: string; description: string; tags: string[]; chapters: Array<{ startSeconds: number; title: string }> };
    expect(body.assetId).toMatch(/^a_/);
    expect(body.title).toBe(SAMPLE_METADATA.title);
    expect(body.description).toBe(SAMPLE_METADATA.description);
    expect(body.tags).toEqual(SAMPLE_METADATA.tags);
    expect(body.chapters).toEqual(SAMPLE_METADATA.chapters);

    // chat must be called once with the outputSchema and the video context
    expect(mockChat).toHaveBeenCalledOnce();
    const [chatArg] = mockChat.mock.calls[0];
    expect((chatArg as Record<string, unknown>).outputSchema).toBeDefined();
    const msgs = (chatArg as { messages: Array<{ role: string; content: string }> }).messages;
    expect(msgs.some((m) => m.content.includes('My video'))).toBe(true);

    // DB.batch must be called once to write generated_assets + ai_costs
    expect((db as { _batchCalls: unknown[][] })._batchCalls).toHaveLength(1);
  });

  it('returns 502 when chat throws', async () => {
    mockChat.mockRejectedValueOnce(new Error('model error'));
    const { res } = postMetadata(metadataUser, { videoId: 'v1' });
    expect((await res).status).toBe(502);
  });

  it('returns 429 at the daily gen cap', async () => {
    const { res } = postMetadata(metadataUser, { videoId: 'v1' }, { aiCostsCount: { n: 50 } });
    expect((await res).status).toBe(429);
  });
});
