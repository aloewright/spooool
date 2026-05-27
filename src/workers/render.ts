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
  RENDER_CONTAINER: DurableObjectNamespace;
  RENDER_CALLBACK_SECRET: string;
  VIDEO_ENCODING: Queue<{ videoId: string; r2Key: string }>;
}

interface SessionUser { id: string }
type RenderVariables = { user: SessionUser | null };

const createBodySchema = z.object({
  takeKeys: z.array(z.string().min(1)).min(1),
  compositionProps: z.object({}).passthrough(),
});

export const renderRoutes = new Hono<{
  Bindings: RenderEnv;
  Variables: RenderVariables;
}>();

renderRoutes.post('/api/render/jobs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const raw = await c.req.json().catch(() => null);
  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const { takeKeys, compositionProps } = parsed.data;

  const jobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO render_jobs (id, user_id, status, composition_spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(jobId, user.id, 'queued', JSON.stringify({ takeKeys, compositionProps }), now, now).run();

  // Fire-and-forget container dispatch.
  const ct = c.env.RENDER_CONTAINER.get(c.env.RENDER_CONTAINER.idFromName(user.id));
  try {
    const res = await ct.fetch('https://render-container/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, takeKeys, compositionProps }),
    });
    if (!res.ok) {
      throw new Error(`Container responded ${res.status}`);
    }
  } catch (err) {
    await c.env.DB.prepare(
      `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).bind(`Container dispatch failed: ${err instanceof Error ? err.message : String(err)}`, Date.now(), jobId).run();
    return c.json({ error: 'Render service unavailable' }, 503);
  }

  return c.json({ jobId });
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

renderRoutes.get('/api/render/jobs/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
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
  return c.json({
    id: row.id,
    status: row.status,
    progress: row.progress,
    outputKey: row.output_r2_key,
    videoId: row.video_id,
    error: row.error_message,
  });
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
  try {
    const spec = JSON.parse(job.composition_spec) as { compositionProps?: { title?: string } };
    if (spec?.compositionProps?.title && typeof spec.compositionProps.title === 'string') {
      title = spec.compositionProps.title;
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
      `INSERT INTO videos (id, user_id, title, description, r2_key, bytes, status, view_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'queued', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(videoId, job.user_id, title, '', body.outputKey),
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
