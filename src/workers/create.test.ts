import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createRoutes, type CreateEnv } from './create';

type SessionUser = { id: string } | null;
function buildApp(user: SessionUser, extra: Partial<CreateEnv> = {}) {
  const app = new Hono<{ Bindings: CreateEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', createRoutes);
  return { app, env: envFor(extra) };
}

function stubDB() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) { binds = args; return this; },
        async run() {
          if (/INSERT INTO create_sessions/i.test(sql)) {
            rows.set(binds[0] as string, { id: binds[0], user_id: binds[1], template_id: binds[2], status: 'questioning' });
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
  } as unknown as D1Database & { rows: typeof rows };
  return db;
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
    const { app, env } = buildApp({ id: 'u_1' });
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
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request('/api/create/templates/hero-journey', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { template: { questions: unknown[] } };
    expect(body.template.questions.length).toBeGreaterThan(0);
  });

  it('404s for unknown id', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request('/api/create/templates/nope', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/create/auto', () => {
  it('invokes runOneShotCMA and returns jobId', async () => {
    const runSpy = vi.fn(async () => ({ jobId: 'j_auto' }));
    const { app, env } = buildApp({ id: 'u_1' }, { runOneShotCMA: runSpy });
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('400s on invalid body', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/create/sessions', () => {
  it('creates a session row and primes the DO, returns sessionId + first question', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
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
});

describe('WS /api/create/sessions/:id/stream', () => {
  it('upgrades the connection and forwards to the DO', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
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
