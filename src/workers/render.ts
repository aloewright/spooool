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
