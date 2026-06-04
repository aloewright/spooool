import { Hono } from 'hono';
import { z } from 'zod';

interface SessionUser {
  id: string;
  emailVerified: boolean;
}
type StudioVariables = { user: SessionUser | null };

export interface StudioEnv {
  DB: D1Database;
  AI_GEN: Queue;
}

const videoGenSchema = z.object({
  prompt: z.string().min(1).max(1000),
  duration: z.number().positive().max(60).optional(),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3']).optional(),
  resolution: z.enum(['480p', '720p', '1080p']).optional(),
  generate_audio: z.boolean().optional(),
  projectId: z.string().optional(),
});

export const studioRoutes = new Hono<{
  Bindings: StudioEnv;
  Variables: StudioVariables;
}>();

studioRoutes.post('/api/studio/video', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const raw = await c.req.json().catch(() => null);
  const parsed = videoGenSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const assetId = crypto.randomUUID();
  const now = Date.now();

  await c.env.DB.prepare(
    'INSERT INTO generated_assets (id, user_id, kind, source, status, spec_json, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      assetId,
      user.id,
      'video',
      'video_gen',
      'queued',
      JSON.stringify(parsed.data),
      parsed.data.projectId ?? null,
      now,
      now,
    )
    .run();

  await c.env.AI_GEN.send({
    assetId,
    userId: user.id,
    ...parsed.data,
  });

  return c.json({ assetId }, 202);
});
