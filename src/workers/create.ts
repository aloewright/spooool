// Routes for the prompt-to-video flow (sub-project #4):
//   GET  /api/create/templates              list available templates
//   GET  /api/create/templates/:id          full template with questions
//   POST /api/create/auto                   one-shot creation via CMA
//   POST /api/create/sessions               start guided DO session
//   GET  /api/create/sessions/:id           snapshot DO state
//   WS   /api/create/sessions/:id/stream    live Q&A + status
//   GET  /api/create/jobs/:id               proxy of /api/render/jobs/:id

import { Hono } from 'hono';
import { z } from 'zod';
import { getTemplate, listTemplateMetadata } from './create/templates';
import type { AIBindingEnv, AIGatewayEnv, R2BindingEnv } from './create-tools';
import type { RenderEnv } from './render';
import { CREATE_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';

export interface CreateEnv extends AIGatewayEnv, R2BindingEnv, AIBindingEnv, RenderEnv {
  DB: D1Database;
  COMPOSER_AGENT: DurableObjectNamespace;
  /** Optional — fail-open in local dev / tests when the binding isn't wired. */
  RATE_LIMITER?: DurableObjectNamespace;
}

interface SessionUser { id: string; emailVerified: boolean }
type CreateVariables = { user: SessionUser | null };

const autoBodySchema = z.object({
  templateId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
});

const sessionBodySchema = z.object({
  templateId: z.string().min(1),
});

export const createRoutes = new Hono<{ Bindings: CreateEnv; Variables: CreateVariables }>();

createRoutes.get('/api/create/templates', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ templates: listTemplateMetadata() });
});

createRoutes.get('/api/create/templates/:id', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  const t = getTemplate(c.req.param('id'));
  if (!t) return c.json({ error: 'Not found' }, 404);
  return c.json({ template: t });
});

createRoutes.post('/api/create/auto', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  // Email verification guard. The frontend gates this at the page level
  // (Create.tsx), but a direct API call would otherwise bypass and burn
  // AI Gateway credits before the account is even verified.
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);
  // Per-user rate limit: 5 generations/hour. Same bucket as the guided
  // sessions endpoint so a malicious client can't trivially route around
  // it by alternating auto / sessions.
  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: CREATE_BUCKET, identity: user.id });
  if (!rl.allowed) {
    return c.json({ error: 'Too many video generations. Try again shortly.' }, 429, rateLimitHeaders(rl));
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = autoBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  // Pre-insert the render_jobs row so the client can start polling
  // /api/create/jobs/:id immediately. Each toolchain stage updates this
  // row to reflect progress (status='rendering' once the container is
  // dispatched, 'completed' / 'failed' from the container callbacks).
  const jobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO render_jobs (id, user_id, status, composition_spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(jobId, user.id, 'queued', JSON.stringify({ pending: true }), now, now).run();
  } catch (err) {
    console.error('[create] auto pre-insert failed', { err: err instanceof Error ? err.message : String(err) });
    return c.json({ error: 'Generation failed' }, 500);
  }

  // Dispatch to a per-job ComposerAgent DO. The DO's runAutoMode method
  // persists state + sets an alarm to kick off the first stage, then
  // returns immediately. Subsequent stages run from the DO's alarm()
  // handler, each in a fresh worker invocation with its own ~30s
  // budget — which is the only way the full draft → plan → tts →
  // finalize chain reliably completes without the route handler's
  // waitUntil being cancelled mid-toolchain.
  try {
    const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(jobId));
    const dispatchRes = await stub.fetch('https://composer-agent/run-auto-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        templateId: parsed.data.templateId,
        prompt: parsed.data.prompt,
        jobId,
      }),
    });
    if (!dispatchRes.ok) {
      const body = await dispatchRes.text().catch(() => '');
      console.error('[create] auto DO dispatch failed', { jobId, status: dispatchRes.status, body: body.slice(0, 200) });
      // Mark the row failed so the client poll sees a terminal state.
      await c.env.DB.prepare(
        `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
      ).bind('Generation failed', Date.now(), jobId).run().catch(() => {});
      return c.json({ error: 'Generation failed' }, 500);
    }
  } catch (err) {
    console.error('[create] auto DO dispatch threw', { jobId, err: err instanceof Error ? err.message : String(err) });
    await c.env.DB.prepare(
      `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).bind('Generation failed', Date.now(), jobId).run().catch(() => {});
    return c.json({ error: 'Generation failed' }, 500);
  }

  return c.json({ jobId });
});

createRoutes.post('/api/create/sessions', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);
  // Same per-user 5/hour bucket as /api/create/auto. The CMA toolchain
  // doesn't fire until the user hits Generate over the WS, but spinning
  // up sessions+DOs is itself non-trivial — and gating both endpoints
  // with the same bucket keeps the abuse model simple.
  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: CREATE_BUCKET, identity: user.id });
  if (!rl.allowed) {
    return c.json({ error: 'Too many video generations. Try again shortly.' }, 429, rateLimitHeaders(rl));
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = sessionBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  if (!getTemplate(parsed.data.templateId)) return c.json({ error: 'Unknown template' }, 400);

  const sessionId = `s_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO create_sessions (id, user_id, template_id, status, answers, created_at, updated_at) VALUES (?, ?, ?, 'questioning', '{}', ?, ?)`,
  ).bind(sessionId, user.id, parsed.data.templateId, now, now).run();

  const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(sessionId));
  const primeRes = await stub.fetch('https://composer-agent/prime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id, templateId: parsed.data.templateId }),
  });
  if (!primeRes.ok) {
    const body = await primeRes.text().catch(() => '');
    return c.json({ error: `Agent prime failed: ${body.slice(0, 200)}` }, 500);
  }
  const primeBody = (await primeRes.json()) as { firstQuestion: { id: string; text: string; hint?: string; multiline?: boolean } };
  return c.json({ sessionId, firstQuestion: primeBody.firstQuestion });
});

createRoutes.get('/api/create/sessions/:id/stream', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (c.req.header('upgrade') !== 'websocket') return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  const sessionId = c.req.param('id');
  // Owner check via DB
  const row = await c.env.DB.prepare(`SELECT user_id FROM create_sessions WHERE id = ?`).bind(sessionId).first<{ user_id: string }>();
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
  const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(sessionId));
  return stub.fetch(new Request(`https://composer-agent/stream`, c.req.raw));
});

createRoutes.get('/api/create/sessions/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT user_id FROM create_sessions WHERE id = ?`).bind(id).first<{ user_id: string }>();
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
  const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(id));
  const res = await stub.fetch('https://composer-agent/snapshot', { method: 'GET' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

createRoutes.get('/api/create/jobs/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, status, progress, output_r2_key, video_id, error_message FROM render_jobs WHERE id = ? AND user_id = ?`,
  ).bind(id, user.id).first<{
    id: string; status: string; progress: number;
    output_r2_key: string | null; video_id: string | null; error_message: string | null;
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

export async function runAbandonedSessionsSweep(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  await db.prepare(
    `UPDATE create_sessions SET status='abandoned', updated_at=? WHERE status='questioning' AND updated_at < ?`,
  ).bind(nowMs, cutoff).run();
}
