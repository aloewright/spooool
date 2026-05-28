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

function stubComposer(opts: { autoModeFails?: boolean } = {}) {
  const calls: Array<{ url: string; body: string | null }> = [];
  const ns = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get() {
      return {
        async fetch(url: string | Request, init?: RequestInit) {
          const u = typeof url === 'string' ? url : url.url;
          const body = init?.body ? String(init.body) : null;
          calls.push({ url: u, body });
          if (u.endsWith('/stream')) {
            // Node's undici Response forbids status 101 — fake it with a
            // plain object that Hono passes through unchanged.
            return { status: 101, body: null, headers: new Headers() } as unknown as Response;
          }
          if (u.endsWith('/run-auto-mode')) {
            if (opts.autoModeFails) return new Response('{"error":"DO unavailable"}', { status: 503 });
            const parsed = body ? JSON.parse(body) as { jobId?: string } : {};
            return new Response(JSON.stringify({ ok: true, jobId: parsed.jobId }), { status: 200 });
          }
          return new Response(JSON.stringify({ firstQuestion: { id: 'protagonist', text: 'Who is the protagonist?' } }), { status: 200 });
        },
      };
    },
  };
  (ns as unknown as { _calls: typeof calls })._calls = calls;
  return ns as unknown as DurableObjectNamespace;
}

function envFor(extra: Partial<CreateEnv> = {}): CreateEnv {
  return {
    DB: stubDB(),
    COMPOSER_AGENT: stubComposer(),
    CF_ACCOUNT_ID: 'a',
    CF_GATEWAY_ID: 'spooool',
    CF_AIG_TOKEN: 't',
    VIDEOS: {} as R2Bucket,
    AI: { run: async () => new Uint8Array() } as unknown as CreateEnv['AI'],
    RENDER_CONTAINER: {} as DurableObjectNamespace,
    RENDER_CALLBACK_SECRET: 's',
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
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
  it('pre-inserts a render_jobs row, dispatches the ComposerAgent DO, returns jobId immediately', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
      fakeExecutionCtx().ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { jobId: string };
    expect(body.jobId).toMatch(/^j_/);
    // Row pre-inserted with status='queued' so the client poll has
    // something to return immediately.
    const renderJobs = (env.DB as unknown as { renderJobs: Map<string, { id: string; status: string }> }).renderJobs;
    expect(renderJobs.get(body.jobId)).toMatchObject({ status: 'queued' });
    // DO was invoked with the right body — toolchain itself runs in the
    // DO's alarm() handler (tested separately in composer-agent-do.test.ts).
    const calls = (env.COMPOSER_AGENT as unknown as { _calls: Array<{ url: string; body: string | null }> })._calls;
    const dispatch = calls.find((c) => c.url.endsWith('/run-auto-mode'));
    expect(dispatch).toBeDefined();
    const dispatchBody = JSON.parse(dispatch!.body ?? '{}') as { jobId: string; userId: string; templateId: string; prompt: string };
    expect(dispatchBody).toMatchObject({ jobId: body.jobId, userId: 'u_1', templateId: 'hero-journey', prompt: 'A junior dev' });
  });

  it('marks the row failed and 500s if DO dispatch fails', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { COMPOSER_AGENT: stubComposer({ autoModeFails: true }) });
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
      fakeExecutionCtx().ctx,
    );
    expect(res.status).toBe(500);
    const renderJobs = (env.DB as unknown as { renderJobs: Map<string, { status: string; error_message: string | null }> }).renderJobs;
    // Even on dispatch failure the route marks the row 'failed' so the
    // client doesn't poll a phantom queued job forever.
    const rows = Array.from(renderJobs.values());
    expect(rows.some((r) => r.status === 'failed')).toBe(true);
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
