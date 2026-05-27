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
import { runOneShotCMA as defaultRunOneShotCMA } from './create-cma';
import type { AIGatewayEnv, R2BindingEnv } from './create-tools';
import type { RenderEnv } from './render';

export interface CreateEnv extends AIGatewayEnv, R2BindingEnv, RenderEnv {
  DB: D1Database;
  COMPOSER_AGENT: DurableObjectNamespace;
  /** Test seam — production uses the imported defaultRunOneShotCMA. */
  runOneShotCMA?: typeof defaultRunOneShotCMA;
}

interface SessionUser { id: string }
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
  const raw = await c.req.json().catch(() => null);
  const parsed = autoBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  const run = c.env.runOneShotCMA ?? defaultRunOneShotCMA;
  try {
    const { jobId } = await run({
      userId: user.id,
      templateId: parsed.data.templateId,
      prompt: parsed.data.prompt,
      env: c.env,
    });
    return c.json({ jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Generation failed, please try rephrasing/.test(msg)) return c.json({ error: msg }, 400);
    console.error('[create] auto failed', { msg });
    return c.json({ error: 'Generation failed' }, 500);
  }
});

createRoutes.post('/api/create/sessions', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
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
