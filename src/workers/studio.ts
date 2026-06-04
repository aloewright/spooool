import { Hono } from 'hono';
import { z } from 'zod';
import type { AiGenMessage } from './ai-video-consumer';

export interface StudioEnv {
  DB: D1Database;
  AI_GEN: Queue<AiGenMessage>;
}

interface SessionUser {
  id: string;
  emailVerified: boolean;
}

type StudioVariables = { user: SessionUser | null };

const videoGenBodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  duration: z.number().int().min(1).max(60).optional(),
  aspectRatio: z.string().optional(),
  resolution: z.string().optional(),
  generateAudio: z.boolean().optional(),
  projectId: z.string().optional(),
});

export const studioRoutes = new Hono<{
  Bindings: StudioEnv;
  Variables: StudioVariables;
}>();

// POST /api/studio/video — enqueue a generative video b-roll job.
// Returns 202 with { assetId } immediately; the AI_GEN queue consumer
// calls env.AI.run('google/veo-3.1', ...) and updates generated_assets.
studioRoutes.post('/api/studio/video', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const raw = await c.req.json().catch(() => null);
  const parsed = videoGenBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const { prompt, duration, aspectRatio, resolution, generateAudio, projectId } = parsed.data;
  const assetId = crypto.randomUUID();
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO generated_assets
       (id, user_id, kind, source, status, spec_json, project_id, bytes, created_at, updated_at)
     VALUES (?, ?, 'video', 'video_gen', 'queued', ?, ?, 0, ?, ?)`,
  ).bind(
    assetId,
    user.id,
    JSON.stringify({ prompt, duration, aspectRatio, resolution, generateAudio }),
    projectId ?? null,
    now,
    now,
  ).run();

  const message: AiGenMessage = {
    assetId,
    userId: user.id,
    prompt,
    ...(duration !== undefined && { duration }),
    ...(aspectRatio !== undefined && { aspectRatio }),
    ...(resolution !== undefined && { resolution }),
    ...(generateAudio !== undefined && { generateAudio }),
  };

  await c.env.AI_GEN.send(message);

  return c.json({ assetId }, 202);
});
