// GET /api/projects/recent — most recently updated edit_projects for the
// authenticated user, joined with the source video's thumbnail. Returns
// Integer ms timestamps directly from the DB (no conversion needed).

import { Hono } from 'hono';
import { z } from 'zod';

export interface ProjectsEnv {
  DB: D1Database;
}

type SessionUser = { id: string } | null;
type ProjectsVariables = { user: SessionUser };

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
});

export interface RecentProjectRow {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  status: string;
  updated_at: number;
}

export const projectRoutes = new Hono<{
  Bindings: ProjectsEnv;
  Variables: ProjectsVariables;
}>();

// GET /api/projects/recent?limit=N
projectRoutes.get('/api/projects/recent', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.status, p.updated_at,
            v.thumbnail_url
     FROM edit_projects p
     LEFT JOIN videos v ON v.id = p.source_video_id
     WHERE p.user_id = ?
     ORDER BY p.updated_at DESC
     LIMIT ?`,
  )
    .bind(user.id, limit)
    .all<RecentProjectRow>();

  return c.json({ items: results ?? [] });
});
