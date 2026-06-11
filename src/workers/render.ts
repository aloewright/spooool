// Routes for the recorder render pipeline. Creating a job inserts into
// render_jobs and dispatches the user's CF Container instance to run the
// actual Remotion render. The container then posts back to the
// /complete | /fail | /progress endpoints (added in a later task) to update the
// job state. Polling clients call GET /api/render/jobs/:id every ~2s.
//
// Per-account isolation: the container instance is keyed on user.id so each
// user's renders run in their own scale-to-zero instance.

import { Hono } from 'hono';
import { z } from 'zod';

export interface RenderEnv {
  DB: D1Database;
  // Optional so existing narrower RenderEnv usages still type-check. In
  // production the full EnvBindings always includes CACHE.
  CACHE?: KVNamespace;
  RENDER_CONTAINER: DurableObjectNamespace;
  RENDER_CALLBACK_SECRET: string;
  VIDEO_ENCODING: Queue<{ videoId: string; r2Key: string }>;
}

interface SessionUser { id: string }
type RenderVariables = { user: SessionUser | null };

const createBodySchema = z.object({
  takeKeys: z.array(z.string().min(1)),
  compositionProps: z.object({}).passthrough(),
});

export const renderRoutes = new Hono<{
  Bindings: RenderEnv;
  Variables: RenderVariables;
}>();

export interface SubmitRenderJobInput {
  userId: string;
  takeKeys: string[];
  compositionProps: Record<string, unknown>;
  env: RenderEnv;
  /**
   * If the caller already inserted the render_jobs row (e.g., the
   * auto-mode route pre-inserts with status='queued' so it can return
   * the jobId synchronously and run the toolchain via waitUntil), pass
   * the existing jobId here and the INSERT will be skipped.
   *
   * This also lets callers thread ONE jobId end-to-end so the TTS R2 key
   * (`recorder/tts/{jobId}.mp3`) matches the final render job id.
   */
  existingJobId?: string;
}

export async function submitRenderJob(input: SubmitRenderJobInput): Promise<{ jobId: string }> {
  const jobId = input.existingJobId ?? `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  if (!input.existingJobId) {
    await input.env.DB.prepare(
      `INSERT INTO render_jobs (id, user_id, status, composition_spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(jobId, input.userId, 'queued', JSON.stringify({ takeKeys: input.takeKeys, compositionProps: input.compositionProps }), now, now).run();
  } else {
    // Caller already inserted the row, but composition_spec was unknown at
    // that point. Patch it in now so the recorded job mirrors what was
    // actually dispatched to the container.
    await input.env.DB.prepare(
      `UPDATE render_jobs SET composition_spec=?, updated_at=? WHERE id=?`,
    ).bind(JSON.stringify({ takeKeys: input.takeKeys, compositionProps: input.compositionProps }), now, jobId).run();
  }

  const ct = input.env.RENDER_CONTAINER.get(input.env.RENDER_CONTAINER.idFromName(input.userId));
  try {
    const res = await ct.fetch('https://render-container/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, takeKeys: input.takeKeys, compositionProps: input.compositionProps }),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '<unreadable>');
      console.error(`[render] container dispatch ${res.status} jobId=${jobId} body=${responseBody.slice(0, 500)}`);
      throw new Error(`Container responded ${res.status}: ${responseBody.slice(0, 200)}`);
    }
  } catch (err) {
    // Best-effort row-fail; never let a secondary D1 error mask the original
    // container error since callers (HTTP handler, future tools/agents) act
    // on the thrown error. runStuckJobSweep catches abandoned rows.
    await input.env.DB.prepare(
      `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).bind(`Container dispatch failed: ${err instanceof Error ? err.message : String(err)}`, Date.now(), jobId).run()
      .catch((dbErr) => console.error(`[render] failed to mark job ${jobId} as failed:`, dbErr));
    throw err;
  }
  return { jobId };
}

renderRoutes.post('/api/render/jobs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const raw = await c.req.json().catch(() => null);
  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  try {
    const { jobId } = await submitRenderJob({
      userId: user.id,
      takeKeys: parsed.data.takeKeys,
      compositionProps: parsed.data.compositionProps as Record<string, unknown>,
      env: c.env,
    });
    return c.json({ jobId });
  } catch {
    return c.json({ error: 'Render service unavailable' }, 503, { 'Retry-After': '60' });
  }
});

function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length; // fold length mismatch into the diff
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function requireCallbackSecret(c: { req: { header: (name: string) => string | undefined }; env: RenderEnv }): Response | null {
  if (!c.env.RENDER_CALLBACK_SECRET) {
    console.error('[render] RENDER_CALLBACK_SECRET is not set');
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  const provided = c.req.header('x-render-secret');
  if (!provided || !timingSafeStringEqual(provided, c.env.RENDER_CALLBACK_SECRET)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

// 1-second KV cache TTL for render job polling. Clients poll every ~2s;
// a 1-second buffer absorbs most D1 round-trips without meaningful stale delay.
const RENDER_JOB_POLL_CACHE_TTL = 1;

renderRoutes.get('/api/render/jobs/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');

  // Short-circuit D1 on every poll tick. Key scoped to user so a user can't
  // read another user's cached status; user.id already comes from the verified
  // session so it's safe to trust here.
  const kvKey = `rjob:${user.id}:${id}`;
  if (c.env.CACHE) {
    const cached = await c.env.CACHE.get(kvKey, 'json') as Record<string, unknown> | null;
    if (cached) return c.json(cached);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, status, progress, output_r2_key, video_id, error_message FROM render_jobs WHERE id = ? AND user_id = ?`,
  ).bind(id, user.id).first<{
    id: string;
    status: string;
    progress: number;
    output_r2_key: string | null;
    video_id: string | null;
    error_message: string | null;
  }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const payload = {
    id: row.id,
    status: row.status,
    progress: row.progress,
    outputKey: row.output_r2_key,
    videoId: row.video_id,
    error: row.error_message,
  };

  // Cache all states: completed/failed are permanent so caching them briefly
  // is harmless, and the client stops polling once it sees a terminal state.
  if (c.env.CACHE) {
    await c.env.CACHE.put(kvKey, JSON.stringify(payload), { expirationTtl: RENDER_JOB_POLL_CACHE_TTL });
  }

  return c.json(payload);
});

renderRoutes.post('/api/render/jobs/:id/complete', async (c) => {
  const denied = requireCallbackSecret(c); if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { outputKey?: string } | null;
  if (!body?.outputKey) return c.json({ error: 'outputKey required' }, 400);

  const job = await c.env.DB.prepare(
    `SELECT id, user_id, composition_spec, status, video_id FROM render_jobs WHERE id = ?`,
  ).bind(id).first<{ id: string; user_id: string; composition_spec: string; status: string; video_id: string | null }>();
  if (!job) return c.json({ error: 'Not found' }, 404);

  // Idempotency: if the job is already completed, return the existing videoId without re-inserting.
  if (job.status === 'completed' && job.video_id) {
    return c.json({ ok: true, videoId: job.video_id });
  }

  let title = 'Untitled recording';
  let aiGenerated = 0;
  try {
    const spec = JSON.parse(job.composition_spec) as {
      compositionProps?: { title?: string; compositionId?: string };
    };
    if (spec?.compositionProps?.title && typeof spec.compositionProps.title === 'string') {
      title = spec.compositionProps.title;
    }
    if (spec?.compositionProps?.compositionId === 'spooool-animation') {
      aiGenerated = 1;
    }
  } catch { /* tolerate malformed spec — use default title */ }

  const videoId = `v_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();

  // `bytes` is set to 0 at INSERT — the rendered MP4's actual size isn't
  // available without a R2 HEAD which we skip to keep the callback cheap.
  // The existing encoding pipeline updates videos.bytes during transcoding,
  // so quota accounting becomes correct once the encoding queue consumes
  // this video. Recordings briefly under-count against storage_quota
  // between INSERT here and the encoding update.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO videos (id, user_id, title, description, r2_key, bytes, status, view_count, ai_generated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'queued', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(videoId, job.user_id, title, '', body.outputKey, aiGenerated),
    c.env.DB.prepare(
      `UPDATE render_jobs SET status='completed', progress=100, output_r2_key=?, video_id=?, updated_at=? WHERE id=?`,
    ).bind(body.outputKey, videoId, now, id),
  ]);

  if (c.env.VIDEO_ENCODING) {
    await c.env.VIDEO_ENCODING.send({ videoId, r2Key: body.outputKey });
  }

  return c.json({ ok: true, videoId });
});

renderRoutes.post('/api/render/jobs/:id/fail', async (c) => {
  const denied = requireCallbackSecret(c); if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { error?: string } | null;
  await c.env.DB.prepare(
    `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
  ).bind(body?.error ?? 'Unknown error', Date.now(), id).run();
  return c.json({ ok: true });
});

renderRoutes.post('/api/render/jobs/:id/progress', async (c) => {
  const denied = requireCallbackSecret(c); if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { progress?: number } | null;
  const progress = Math.max(0, Math.min(100, Math.floor(body?.progress ?? 0)));
  await c.env.DB.prepare(
    `UPDATE render_jobs SET status='rendering', progress=?, updated_at=? WHERE id=?`,
  ).bind(progress, Date.now(), id).run();
  return c.json({ ok: true });
});

/**
 * Mark any render_jobs that have been in `rendering` for more than 15 minutes
 * as failed. Called from the `scheduled` handler every 5 minutes (see
 * wrangler.toml). Operationally cheap because the idx_render_jobs_stuck
 * index covers (status, updated_at).
 */
export async function runStuckJobSweep(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 15 * 60 * 1000;
  await db.prepare(
    `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE status='rendering' AND updated_at < ?`,
  ).bind('Render timeout', nowMs, cutoff).run();
}
