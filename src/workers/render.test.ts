import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { renderRoutes, type RenderEnv } from './render';

type SessionUser = { id: string } | null;

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: RenderEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', renderRoutes);
  return app;
}

function stubDB() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) { binds = args; return this; },
        async run() {
          if (/^INSERT INTO render_jobs/i.test(sql)) {
            rows.set(binds[0] as string, {
              id: binds[0], user_id: binds[1], status: binds[2], progress: 0,
              composition_spec: binds[3], output_r2_key: null, video_id: null,
              error_message: null, created_at: binds[4], updated_at: binds[4],
            });
          } else if (/^UPDATE render_jobs/i.test(sql)) {
            // simple match: last bind is the id
            const id = binds[binds.length - 1] as string;
            const row = rows.get(id);
            if (row) {
              if (/status='failed'/i.test(sql)) row.status = 'failed';
              if (/error_message=\?/i.test(sql)) row.error_message = binds[0];
            }
          }
          return { success: true };
        },
        async first<T>() {
          if (/^SELECT .* FROM render_jobs WHERE id = \? AND user_id = \?/i.test(sql)) {
            const row = rows.get(binds[0] as string);
            if (row && row.user_id === binds[1]) return row as T;
            return null;
          }
          return null;
        },
      };
    },
    rows,
  } as unknown as D1Database & { rows: Map<string, Record<string, unknown>> };
  return db;
}

function stubContainer() {
  const calls: Array<{ id: string; path: string; body: unknown }> = [];
  const ns = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get(_id: DurableObjectId) {
      return {
        fetch: async (path: string, init?: RequestInit) => {
          calls.push({
            id: (_id as unknown as { name: string }).name,
            path,
            body: init?.body ? JSON.parse(init.body as string) : null,
          });
          return new Response('{}', { status: 200 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  (ns as unknown as { _calls: typeof calls })._calls = calls;
  return ns;
}

function envFor(extra: Partial<RenderEnv> = {}): RenderEnv {
  return {
    DB: stubDB(),
    RENDER_CONTAINER: stubContainer(),
    RENDER_CALLBACK_SECRET: 'secret_test',
    ...extra,
  } as RenderEnv;
}

describe('POST /api/render/jobs', () => {
  it('401s when there is no session', async () => {
    const res = await buildApp(null).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor(),
    );
    expect(res.status).toBe(401);
  });

  it('creates a job row, dispatches the container, and returns jobId', async () => {
    const env = envFor();
    const res = await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          takeKeys: ['recorder/raw/u_1/s/take_001.webm'],
          compositionProps: { title: 'hi', brand: { color: '#000' }, sceneOrder: ['main'], layouts: {} },
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toMatch(/^j_/);
    const calls = (env.RENDER_CONTAINER as unknown as { _calls: Array<{ id: string; path: string; body: unknown }> })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('https://render-container/render');
    expect(calls[0].id).toBe('u_1');
    expect(calls[0].body).toMatchObject({ jobId: body.jobId, takeKeys: ['recorder/raw/u_1/s/take_001.webm'] });
  });

  it('400s on missing takeKeys', async () => {
    const res = await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ compositionProps: {} }) },
      envFor(),
    );
    expect(res.status).toBe(400);
  });

  it('marks job failed and returns 503 when container dispatch throws', async () => {
    const env = envFor();
    // Override the container fetch to throw
    (env.RENDER_CONTAINER as unknown as { get: () => { fetch: () => Promise<Response> } }).get = () => ({
      fetch: async () => { throw new Error('boom'); },
    });
    const res = await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }),
      },
      env,
    );
    expect(res.status).toBe(503);
    // Job row was created then marked failed
    const rows = [...((env.DB as unknown as { rows: Map<string, { status: string }> }).rows.values())];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });

  it('marks job failed and returns 503 when container responds non-2xx', async () => {
    const env = envFor();
    (env.RENDER_CONTAINER as unknown as { get: () => { fetch: () => Promise<Response> } }).get = () => ({
      fetch: async () => new Response('{"error":"queue full"}', { status: 429 }),
    });
    const res = await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }),
      },
      env,
    );
    expect(res.status).toBe(503);
    const rows = [...((env.DB as unknown as { rows: Map<string, { status: string }> }).rows.values())];
    expect(rows[0].status).toBe('failed');
  });
});

describe('GET /api/render/jobs/:id', () => {
  it('returns the job when owned by the session user', async () => {
    const env = envFor();
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }),
      },
      env,
    );
    const created = [...((env.DB as unknown as { rows: Map<string, { id: string }> }).rows.values())][0];
    const res = await buildApp({ id: 'u_1' }).request(
      `/api/render/jobs/${created.id}`,
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; progress: number };
    expect(body).toMatchObject({ id: created.id, status: 'queued', progress: 0 });
  });

  it('404s when the job belongs to another user', async () => {
    const env = envFor();
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }),
      },
      env,
    );
    const created = [...((env.DB as unknown as { rows: Map<string, { id: string }> }).rows.values())][0];
    const res = await buildApp({ id: 'u_2' }).request(`/api/render/jobs/${created.id}`, { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});
