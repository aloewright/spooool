import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { renderRoutes, submitRenderJob, type RenderEnv } from './render';

type SessionUser = { id: string } | null;

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: RenderEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', renderRoutes);
  return app;
}

function stubDB() {
  const rows = new Map<string, Record<string, unknown>>();
  const videos = new Map<string, Record<string, unknown>>();
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
          } else if (/^INSERT INTO videos/i.test(sql)) {
            videos.set(binds[0] as string, { id: binds[0], user_id: binds[1], r2_key: binds[4] });
          } else if (/^UPDATE render_jobs/i.test(sql)) {
            // simple match: last bind is the id
            const id = binds[binds.length - 1] as string;
            const row = rows.get(id);
            if (row) {
              if (/status='failed'/i.test(sql)) {
                row.status = 'failed';
                if (/error_message=\?/i.test(sql)) row.error_message = binds[0];
              } else if (/status='completed'/i.test(sql)) {
                row.status = 'completed';
                row.progress = 100;
                row.output_r2_key = binds[0];
                row.video_id = binds[1];
              } else if (/status='rendering'/i.test(sql)) {
                row.status = 'rendering';
                row.progress = binds[0];
              }
            }
          }
          return { success: true };
        },
        async first<T>() {
          if (/SELECT id, status, progress.*WHERE id = \? AND user_id = \?/i.test(sql)) {
            const row = rows.get(binds[0] as string);
            if (row && row.user_id === binds[1]) return row as T;
            return null;
          }
          if (/SELECT id, user_id, composition_spec(?:, status, video_id)? FROM render_jobs WHERE id = \?/i.test(sql)) {
            return (rows.get(binds[0] as string) ?? null) as T;
          }
          return null;
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    rows,
    videos,
  } as unknown as D1Database & { rows: Map<string, Record<string, unknown>>; videos: Map<string, Record<string, unknown>> };
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
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    ...extra,
  } as RenderEnv;
}

describe('container callbacks', () => {
  function stubQueue() {
    const send = vi.fn(async () => {});
    return { send } as unknown as Queue<{ videoId: string; r2Key: string }> & { send: ReturnType<typeof vi.fn> };
  }

  async function createJob(env: RenderEnv): Promise<string> {
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeKeys: ['k'], compositionProps: { title: 'My recording' } }),
      },
      env,
    );
    const rows = [...((env.DB as unknown as { rows: Map<string, { id: string }> }).rows.values())];
    return rows[0].id;
  }

  it('rejects callbacks without the shared secret', async () => {
    const env = envFor();
    const res = await buildApp(null).request(
      '/api/render/jobs/j_x/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputKey: 'k' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('POST /complete marks the job completed, creates videos row, enqueues encoding', async () => {
    const queue = stubQueue();
    const env = envFor({ VIDEO_ENCODING: queue });
    const jobId = await createJob(env);
    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ outputKey: `recorder/renders/${jobId}.mp4` }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { videoId: string };
    expect(body.videoId).toMatch(/^v_/);
    // Queue received one send
    expect((queue as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
    expect((queue as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith({
      videoId: body.videoId,
      r2Key: `recorder/renders/${jobId}.mp4`,
    });
  });

  it('POST /progress updates progress percentage and flips status to rendering', async () => {
    const env = envFor();
    const jobId = await createJob(env);
    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/progress`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ progress: 42 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    // Verify the row was updated
    const rows = [...((env.DB as unknown as { rows: Map<string, { status: string; progress: number }> }).rows.values())];
    expect(rows[0].status).toBe('rendering');
    expect(rows[0].progress).toBe(42);
  });

  it('POST /fail marks the job failed with the supplied error', async () => {
    const env = envFor();
    const jobId = await createJob(env);
    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/fail`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ error: 'remotion crashed' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const rows = [...((env.DB as unknown as { rows: Map<string, { status: string; error_message: string | null }> }).rows.values())];
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toBe('remotion crashed');
  });

  it('POST /complete returns 404 when the job does not exist', async () => {
    const env = envFor();
    const res = await buildApp(null).request(
      '/api/render/jobs/j_nonexistent/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ outputKey: 'k' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('/complete is idempotent — second POST returns the same videoId without duplicate INSERT', async () => {
    const queue = stubQueue();
    const env = envFor({ VIDEO_ENCODING: queue });
    const jobId = await createJob(env);
    const first = await buildApp(null).request(
      `/api/render/jobs/${jobId}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ outputKey: `recorder/renders/${jobId}.mp4` }),
      },
      env,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { videoId: string };

    const second = await buildApp(null).request(
      `/api/render/jobs/${jobId}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ outputKey: `recorder/renders/${jobId}.mp4` }),
      },
      env,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { videoId: string };
    expect(secondBody.videoId).toBe(firstBody.videoId);
    // Only one video row, only one queue send
    const videos = (env.DB as unknown as { videos: Map<string, unknown> }).videos;
    expect(videos.size).toBe(1);
    expect((queue as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
  });

  it('POST /complete returns 400 when outputKey is missing', async () => {
    const env = envFor();
    const jobId = await createJob(env);
    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('POST /progress clamps progress to 0..100', async () => {
    const env = envFor();
    const jobId = await createJob(env);
    await buildApp(null).request(
      `/api/render/jobs/${jobId}/progress`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ progress: 150 }),
      },
      env,
    );
    let rows = [...((env.DB as unknown as { rows: Map<string, { progress: number }> }).rows.values())];
    expect(rows[0].progress).toBe(100);
    await buildApp(null).request(
      `/api/render/jobs/${jobId}/progress`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ progress: -5 }),
      },
      env,
    );
    rows = [...((env.DB as unknown as { rows: Map<string, { progress: number }> }).rows.values())];
    expect(rows[0].progress).toBe(0);
  });
});

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

describe('submitRenderJob (direct call)', () => {
  it('inserts a render_jobs row, dispatches the container, returns jobId', async () => {
    const env = envFor();
    const result = await submitRenderJob({
      userId: 'u_direct',
      takeKeys: ['recorder/raw/u_direct/s/take_001.webm'],
      compositionProps: { title: 'direct call' },
      env,
    });
    expect(result.jobId).toMatch(/^j_/);
    const rows = [...((env.DB as unknown as { rows: Map<string, { user_id: string }> }).rows.values())];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('u_direct');
    const calls = (env.RENDER_CONTAINER as unknown as { _calls: Array<{ id: string }> })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('u_direct');
  });

  it('throws when container dispatch fails, leaving the job marked failed', async () => {
    const env = envFor();
    (env.RENDER_CONTAINER as unknown as { get: () => { fetch: () => Promise<Response> } }).get = () => ({
      fetch: async () => new Response('{"error":"x"}', { status: 500 }),
    });
    await expect(
      submitRenderJob({ userId: 'u_x', takeKeys: ['k'], compositionProps: {}, env }),
    ).rejects.toThrow(/Container responded 500/);
    const rows = [...((env.DB as unknown as { rows: Map<string, { status: string }> }).rows.values())];
    expect(rows[0].status).toBe('failed');
  });
});

describe('runStuckJobSweep', () => {
  it('marks jobs older than 15 minutes in rendering as failed', async () => {
    const { runStuckJobSweep } = await import('./render');
    const updated: Array<unknown[]> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (/UPDATE render_jobs/i.test(sql) && /status='failed'/i.test(sql) && /WHERE status='rendering'/i.test(sql)) {
              updated.push(args);
            }
            return this;
          },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database;
    await runStuckJobSweep(db, 1_700_000_000_000);
    expect(updated).toHaveLength(1);
    expect(updated[0][0]).toBe('Render timeout');
    expect(updated[0][1]).toBe(1_700_000_000_000);
    expect(updated[0][2]).toBe(1_700_000_000_000 - 15 * 60 * 1000);
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
