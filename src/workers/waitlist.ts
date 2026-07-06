import { Hono } from 'hono';
import { z } from 'zod';
import { isAdmin, type RolesEnv } from './roles';
import { sendInviteEmail, type EmailEnv } from './email';

export interface WaitlistEnv extends RolesEnv, EmailEnv {
  DB: D1Database;
  /** Public origin used to build invite URLs, e.g. https://spooool.com */
  BETTER_AUTH_URL?: string;
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

const inviteSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(100).optional(),
});

// Admin: send a beta invite email. Idempotent — re-sending to an already-invited
// (but not yet accepted) email refreshes the token and expiry.
waitlistRoutes.post('/api/admin/invites', async (c) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) return c.json({ error: 'Forbidden' }, 403);

  const json = await c.req.json().catch(() => null);
  const parsed = inviteSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { email, name } = parsed.data;
  const token = crypto.randomUUID();
  const id = crypto.randomUUID();
  // 7-day expiry
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Upsert: delete any non-accepted prior invite for this email, then insert fresh.
  await c.env.DB.prepare(
    `DELETE FROM invites WHERE email = ? AND accepted_at IS NULL`,
  ).bind(email.toLowerCase().trim()).run();

  await c.env.DB.prepare(
    `INSERT INTO invites (id, token, email, name, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, token, email.toLowerCase().trim(), name ?? null, expiresAt).run();

  const origin = c.env.BETTER_AUTH_URL?.replace(/\/$/, '') ?? 'https://spooool.com';
  const inviteUrl = `${origin}/invite/${token}`;

  const result = await sendInviteEmail(c.env, { to: email, name, inviteUrl });
  if (!result.ok && !result.skipped) {
    console.error('[invites] email send failed', result.message);
    return c.json({ error: 'Failed to send invite email' }, 500);
  }

  return c.json({ ok: true, token, expiresAt }, 201);
});

// Public: validate an invite token (used by the accept page before showing signup).
waitlistRoutes.get('/api/invite/:token', async (c) => {
  const { token } = c.req.param();
  const row = await c.env.DB.prepare(
    `SELECT id, email, name, expires_at, accepted_at FROM invites WHERE token = ?`,
  ).bind(token).first<{ id: string; email: string; name: string | null; expires_at: string; accepted_at: string | null }>();

  if (!row) return c.json({ error: 'Invalid invite' }, 404);
  if (row.accepted_at) return c.json({ error: 'Invite already used' }, 410);
  if (new Date(row.expires_at) < new Date()) return c.json({ error: 'Invite expired' }, 410);

  return c.json({ ok: true, email: row.email, name: row.name });
});

// Public: mark an invite as accepted (called fire-and-forget after signup).
waitlistRoutes.post('/api/invite/:token/accept', async (c) => {
  const { token } = c.req.param();
  const result = await c.env.DB.prepare(
    `UPDATE invites SET accepted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE token = ? AND accepted_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  ).bind(token).run();

  if (result.meta.changes === 0) return c.json({ error: 'Invite not found or already used' }, 410);
  return c.json({ ok: true });
});
