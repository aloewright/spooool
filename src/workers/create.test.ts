import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createRoutes, type CreateEnv } from './create';

type SessionUser = { id: string; emailVerified: boolean } | null;
function buildApp(user: SessionUser, extra: Partial<CreateEnv> = {}) {
  const app = new Hono<{ Bindings: CreateEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', createRoutes);
  return { app, env: envFor(extra) };
}

function stubDB() {
  const rows = new Map<string, Record<string, unknown>>();
  const renderJobs = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) { binds = args; return this; },
        async run() {
          if (/INSERT INTO create_sessions/i.test(sql)) {
            rows.set(binds[0] as string, { id: binds[0], user_id: binds[1], template_id: binds[2], status: 'questioning' });
          } else if (/INSERT INTO render_jobs/i.test(sql)) {
            renderJobs.set(binds[0] as string, {
              id: binds[0], user_id: binds[1], status: binds[2], composition_spec: binds[3],
              error_message: null, created_at: binds[4], updated_at: binds[5],
            });
          } else if (/UPDATE render_jobs/i.test(sql)) {
            const id = binds[binds.length - 1] as string;
            const row = renderJobs.get(id);
            if (row) {
              if (/status='failed'/i.test(sql)) {
                row.status = 'failed';
                row.error_message = binds[0];
                row.updated_at = binds[1];
              }
            }
          }
          return { success: true };
        },
        async first<T>(): Promise<T | null> {
          if (/SELECT user_id FROM create_sessions WHERE id = \?/i.test(sql)) {
            return { user_id: 'u_1' } as T;
          }
          return null;
        },
      };
    },
    rows,
    renderJobs,
  } as unknown as D1Database & { rows: typeof rows; renderJobs: typeof renderJobs };
  return db;
}

function fakeExecutionCtx() {
  const pending: Array<Promise<unknown>> = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) { pending.push(p); },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    /** Await everything queued via waitUntil — used by tests that need to
     *  assert on toolchain side effects (DB writes, mock calls). */
    async drain() { await Promise.allSettled(pending); },
  };
}

function stubComposer() {
  const ns = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get() {
      return {
        async fetch(url: string | Request, init?: RequestInit) {
          const u = typeof url === 'string' ? url : url.url;
          if (u.endsWith('/stream')) {
            // Node's undici Response forbids status 101 — fake it with a
            // plain object that Hono passes through unchanged.
            return { status: 101, body: null, headers: new Headers() } as unknown as Response;
          }
          return new Response(JSON.stringify({ firstQuestion: { id: 'protagonist', text: 'Who is the protagonist?' } }), { status: 200 });
        },
      };
    },
  };
  return ns as unknown as DurableObjectNamespace;
}

function envFor(extra: Partial<CreateEnv> = {}): CreateEnv {
  return {
    DB: stubDB(),
    COMPOSER_AGENT: stubComposer(),
    CF_ACCOUNT_ID: 'a',
    CF_GATEWAY_ID: 'x',
    CF_AIG_TOKEN: 't',
    VIDEOS: {} as R2Bucket,
    RENDER_CONTAINER: {} as DurableObjectNamespace,
    RENDER_CALLBACK_SECRET: 's',
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    runOneShotCMA: vi.fn(async () => ({ jobId: 'j_auto' })),
    ...extra,
  } as CreateEnv;
}

describe('GET /api/create/templates', () => {
  it('returns the template metadata without question text', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request('/api/create/templates', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: Array<{ id: string; questions?: unknown }> };
    expect(body.templates[0].id).toBe('hero-journey');
    expect(body.templates[0].questions).toBeUndefined();
  });

  it('401s without session', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request('/api/create/templates', { method: 'GET' }, env);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/create/templates/:id', () => {
  it('returns the full template with questions', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request('/api/create/templates/hero-journey', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { template: { questions: unknown[] } };
    expect(body.template.questions.length).toBeGreaterThan(0);
  });

  it('404s for unknown id', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request('/api/create/templates/nope', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/create/auto', () => {
  it('pre-inserts a render_jobs row, returns jobId immediately, runs toolchain via waitUntil', async () => {
    const runSpy = vi.fn(async (args: { jobId: string }) => ({ jobId: args.jobId }));
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { runOneShotCMA: runSpy });
    const exec = fakeExecutionCtx();
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
      exec.ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string };
    expect(body.jobId).toMatch(/^j_/);
    // Row was pre-inserted with status='queued' BEFORE the toolchain runs.
    const renderJobs = (env.DB as unknown as { renderJobs: Map<string, { id: string; status: string }> }).renderJobs;
    expect(renderJobs.get(body.jobId)).toMatchObject({ status: 'queued' });
    // Drain waitUntil and confirm the toolchain was invoked with the SAME jobId.
    await exec.drain();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toMatchObject({ jobId: body.jobId, userId: 'u_1', templateId: 'hero-journey' });
  });

  it('marks the row failed when the toolchain throws', async () => {
    const runSpy = vi.fn(async () => { throw new Error('boom'); });
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { runOneShotCMA: runSpy });
    const exec = fakeExecutionCtx();
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
      exec.ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string };
    await exec.drain();
    const renderJobs = (env.DB as unknown as { renderJobs: Map<string, { status: string; error_message: string | null }> }).renderJobs;
    const row = renderJobs.get(body.jobId);
    expect(row?.status).toBe('failed');
    expect(row?.error_message).toBe('Generation failed');
  });

  it('passes through content-policy refusal as the row error message', async () => {
    const runSpy = vi.fn(async () => { throw new Error('Generation failed, please try rephrasing your prompt.'); });
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { runOneShotCMA: runSpy });
    const exec = fakeExecutionCtx();
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
      exec.ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string };
    await exec.drain();
    const renderJobs = (env.DB as unknown as { renderJobs: Map<string, { status: string; error_message: string | null }> }).renderJobs;
    const row = renderJobs.get(body.jobId);
    expect(row?.status).toBe('failed');
    expect(row?.error_message).toMatch(/please try rephrasing/);
  });

  it('400s on invalid body', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const exec = fakeExecutionCtx();
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      env,
      exec.ctx,
    );
    expect(res.status).toBe(400);
  });

  it('403s when emailVerified is false', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: false });
    const exec = fakeExecutionCtx();
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'x' }) },
      env,
      exec.ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/create/sessions', () => {
  it('creates a session row and primes the DO, returns sessionId + first question', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request(
      '/api/create/sessions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey' }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; firstQuestion: { id: string } };
    expect(body.sessionId).toMatch(/^s_/);
    expect(body.firstQuestion.id).toBe('protagonist');
  });

  it('403s when emailVerified is false', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: false });
    const res = await app.request(
      '/api/create/sessions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey' }) },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('WS /api/create/sessions/:id/stream', () => {
  it('upgrades the connection and forwards to the DO', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request(
      '/api/create/sessions/s_abc/stream',
      { method: 'GET', headers: { upgrade: 'websocket' } },
      env,
    );
    expect(res.status).toBe(101);
  });

  it('401 without session', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request(
      '/api/create/sessions/s_abc/stream',
      { method: 'GET', headers: { upgrade: 'websocket' } },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('runAbandonedSessionsSweep', () => {
  it('marks questioning sessions older than 24h as abandoned', async () => {
    const { runAbandonedSessionsSweep } = await import('./create');
    const updated: Array<unknown[]> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (/UPDATE create_sessions/i.test(sql)) updated.push(args);
            return this;
          },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database;
    await runAbandonedSessionsSweep(db, 1_700_000_000_000);
    expect(updated).toHaveLength(1);
    expect(updated[0][0]).toBe(1_700_000_000_000);
    expect(updated[0][1]).toBe(1_700_000_000_000 - 24 * 60 * 60 * 1000);
  });
});
