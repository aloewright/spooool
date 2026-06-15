import { Hono } from 'hono';
import { z } from 'zod';
import { isAdmin, type RolesEnv } from './roles';

export interface WaitlistEnv extends RolesEnv {
  DB: D1Database;
}

type SessionUser = { id: string; email: string; name: string } | null;
type WaitlistVariables = { user: SessionUser };

const joinSchema = z.object({
  email: z.string().email().max(254),
  name:  z.string().max(100).optional(),
  source: z.string().max(50).optional().default('landing'),
});

export const waitlistRoutes = new Hono<{
  Bindings: WaitlistEnv;
  Variables: WaitlistVariables;
}>();

waitlistRoutes.post('/api/waitlist', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = joinSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { email, name, source } = parsed.data;
  const id = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO waitlist (id, email, name, source) VALUES (?, ?, ?, ?)`,
    ).bind(id, email.toLowerCase().trim(), name ?? null, source).run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint')) {
      // Already on the waitlist — treat as success so we don't leak existence.
      return c.json({ ok: true });
    }
    console.error('[waitlist] insert failed', { error: msg });
    return c.json({ error: 'Server error' }, 500);
  }

  return c.json({ ok: true }, 201);
});

waitlistRoutes.get('/api/admin/waitlist', async (c) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) return c.json({ error: 'Forbidden' }, 403);

  const limit  = Math.min(100, Math.max(1, Number(c.req.query('limit')  ?? 50)));
  const page   = Math.max(1, Number(c.req.query('page') ?? 1));
  const offset = (page - 1) * limit;

  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, email, name, source, created_at FROM waitlist
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(limit, offset).all<{ id: string; email: string; name: string | null; source: string; created_at: string }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM waitlist`).first<{ n: number }>(),
  ]);

  return c.json({ page, limit, total: total?.n ?? 0, entries: results ?? [] });
});
