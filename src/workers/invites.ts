import { Hono } from 'hono';
import { z } from 'zod';
import { isAdmin } from './roles';
import {
  sendBetaInviteEmail,
  sendWaitlistConfirmEmail,
  type EmailEnv,
  type EmailResult,
} from './email';

export interface InvitesEnv extends EmailEnv {
  DB: D1Database;
  ADMIN_EMAILS?: string;
}

type SessionUser = { id: string; email: string; name: string } | null;
type InvitesVariables = { user: SessionUser };

function logEmailResult(result: EmailResult, kind: string, to: string): void {
  if (result.ok) return;
  if (result.skipped) {
    console.warn(`[invites] email ${kind} -> ${to} skipped: ${result.reason}`);
    return;
  }
  console.error(`[invites] email ${kind} -> ${to} failed: ${result.message}`);
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  const raw = Array.from(arr, (b) => chars[b % chars.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function generateToken(): string {
  const arr = new Uint8Array(20);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

const waitlistJoinSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
});

const redeemSchema = z.object({
  code: z.string().min(1).max(64),
});

const generateCodesSchema = z.object({
  count: z.number().int().min(1).max(200).default(1),
  wave: z.number().int().min(1).default(1),
  maxUses: z.number().int().min(1).max(1000).default(1),
  note: z.string().max(200).optional(),
  expiresAt: z.number().int().optional(),
});

const sendInvitesSchema = z.object({
  emails: z.array(z.string().email().max(254)).max(100).optional(),
  count: z.number().int().min(1).max(100).optional(),
  wave: z.number().int().min(1).default(1),
});

interface InviteCodeRow {
  code: string;
  created_by: string | null;
  wave: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  expires_at: number | null;
  created_at: number;
}

interface WaitlistRow {
  id: string;
  email: string;
  status: string;
  token: string;
  invite_code: string | null;
  created_at: number;
  invited_at: number | null;
}

export const inviteRoutes = new Hono<{
  Bindings: InvitesEnv;
  Variables: InvitesVariables;
}>();

// ── Public: join waitlist ────────────────────────────────────────────────────

inviteRoutes.post('/api/waitlist', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = waitlistJoinSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid email', details: parsed.error.flatten() }, 400);
  }
  const { email } = parsed.data;

  const existing = await c.env.DB.prepare('SELECT id, status FROM waitlist WHERE email = ?')
    .bind(email)
    .first<{ id: string; status: string }>();

  if (existing) {
    // Idempotent — don't reveal exact status to avoid enumeration
    return c.json({ ok: true, alreadyRegistered: true });
  }

  const id = crypto.randomUUID();
  const token = generateToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO waitlist (id, email, status, token, created_at) VALUES (?, ?, 'pending', ?, ?)`,
  )
    .bind(id, email, token, now)
    .run();

  const result = await sendWaitlistConfirmEmail(c.env, { to: email });
  logEmailResult(result, 'waitlist_confirm', email);

  return c.json({ ok: true });
});

// ── Public: get invite code info (for the /invite/:code landing page) ────────

inviteRoutes.get('/api/invite/:code', async (c) => {
  const code = c.req.param('code');
  const row = await c.env.DB.prepare(
    `SELECT code, wave, max_uses, used_count, expires_at, created_at FROM invite_codes WHERE code = ?`,
  )
    .bind(code)
    .first<Pick<InviteCodeRow, 'code' | 'wave' | 'max_uses' | 'used_count' | 'expires_at' | 'created_at'>>();

  if (!row) return c.json({ error: 'Invite not found' }, 404);

  const exhausted = row.used_count >= row.max_uses;
  const expired = row.expires_at !== null && row.expires_at < Date.now();
  if (exhausted || expired) {
    return c.json({ error: 'Invite is no longer valid', exhausted, expired }, 410);
  }

  return c.json({
    code: row.code,
    wave: row.wave,
    spotsLeft: row.max_uses - row.used_count,
    expiresAt: row.expires_at,
  });
});

// ── Authenticated: redeem invite code after signup ───────────────────────────

inviteRoutes.post('/api/invite/redeem', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // Idempotent — already has access
  const existing = await c.env.DB.prepare('SELECT beta_access FROM user WHERE id = ?')
    .bind(user.id)
    .first<{ beta_access: number }>();
  if (existing?.beta_access) return c.json({ ok: true, alreadyGranted: true });

  const body = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { code } = parsed.data;

  const row = await c.env.DB.prepare(
    `SELECT code, max_uses, used_count, expires_at FROM invite_codes WHERE code = ?`,
  )
    .bind(code)
    .first<Pick<InviteCodeRow, 'code' | 'max_uses' | 'used_count' | 'expires_at'>>();

  if (!row) return c.json({ error: 'Invite code not found' }, 404);
  if (row.used_count >= row.max_uses) return c.json({ error: 'Invite code is exhausted' }, 410);
  if (row.expires_at !== null && row.expires_at < Date.now()) {
    return c.json({ error: 'Invite code has expired' }, 410);
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?`
    ).bind(code),
    c.env.DB.prepare(
      `UPDATE user SET invite_code = ?, beta_access = 1, updatedAt = ? WHERE id = ?`,
    ).bind(code, now, user.id),
    // If this invite was linked to a waitlist entry, mark them as joined
    c.env.DB.prepare(
      `UPDATE waitlist SET status = 'joined' WHERE invite_code = ? AND status = 'invited'`,
    ).bind(code),
    // Also handle if they joined waitlist directly (email match)
    c.env.DB.prepare(
      `UPDATE waitlist SET status = 'joined' WHERE email = ? AND status != 'joined'`,
    ).bind(user.email.toLowerCase()),
  ]);

  return c.json({ ok: true });
});

// ── Admin: generate invite codes ─────────────────────────────────────────────

inviteRoutes.post('/api/admin/invite-codes', async (c) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = generateCodesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { count, wave, maxUses, note, expiresAt } = parsed.data;

  const now = Date.now();
  const codes: string[] = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode();
    codes.push(code);
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO invite_codes (code, created_by, wave, max_uses, used_count, note, expires_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      ).bind(code, user!.id, wave, maxUses, note ?? null, expiresAt ?? null, now),
    );
  }
  await c.env.DB.batch(stmts);

  return c.json({ ok: true, codes }, 201);
});

// ── Admin: list invite codes ─────────────────────────────────────────────────

inviteRoutes.get('/api/admin/invite-codes', async (c) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) return c.json({ error: 'Forbidden' }, 403);

  const waveStr = c.req.query('wave');
  const waveParsed = waveStr ? parseInt(waveStr, 10) : NaN;
  const wave = waveStr && !isNaN(waveParsed) ? waveParsed : null;
  const limitStr = c.req.query('limit') ?? '100';
  const offsetStr = c.req.query('offset') ?? '0';
  const limit = Math.min(parseInt(limitStr, 10) || 100, 500);
  const offset = parseInt(offsetStr, 10) || 0;

  const { results } = await c.env.DB.prepare(
    `SELECT ic.code, ic.wave, ic.max_uses, ic.used_count, ic.note, ic.expires_at, ic.created_at,
            u.email AS created_by_email
     FROM invite_codes ic
     LEFT JOIN user u ON u.id = ic.created_by
     ${wave !== null ? 'WHERE ic.wave = ?' : ''}
     ORDER BY ic.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...(wave !== null ? [wave, limit, offset] : [limit, offset]))
    .all<InviteCodeRow & { created_by_email: string | null }>();

  return c.json({ codes: results ?? [] });
});

// ── Admin: list waitlist ─────────────────────────────────────────────────────

inviteRoutes.get('/api/admin/waitlist', async (c) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) return c.json({ error: 'Forbidden' }, 403);

  const status = c.req.query('status');
  const limitStr = c.req.query('limit') ?? '100';
  const offsetStr = c.req.query('offset') ?? '0';
  const limit = Math.min(parseInt(limitStr, 10) || 100, 500);
  const offset = parseInt(offsetStr, 10) || 0;

  const validStatuses = new Set(['pending', 'invited', 'joined']);
  const statusFilter = status && validStatuses.has(status) ? status : null;

  const { results } = await c.env.DB.prepare(
    `SELECT id, email, status, invite_code, created_at, invited_at
     FROM waitlist
     ${statusFilter ? 'WHERE status = ?' : ''}
     ORDER BY created_at ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...(statusFilter ? [statusFilter, limit, offset] : [limit, offset]))
    .all<Omit<WaitlistRow, 'token'>>();

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM waitlist ${statusFilter ? 'WHERE status = ?' : ''}`,
  )
    .bind(...(statusFilter ? [statusFilter] : []))
    .first<{ n: number }>();

  return c.json({ entries: results ?? [], total: total?.n ?? 0 });
});

// ── Admin: send invites to waitlist entries ───────────────────────────────────

inviteRoutes.post('/api/admin/waitlist/invite', async (c) => {
  const adminUser = c.get('user');
  if (!(await isAdmin(c.env, adminUser))) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = sendInvitesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { emails, count, wave } = parsed.data;
  let targets: WaitlistRow[];

  if (emails && emails.length > 0) {
    const lower = emails.map((e) => e.toLowerCase());
    const placeholders = lower.map(() => '?').join(', ');
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, status, token, invite_code, created_at, invited_at
       FROM waitlist WHERE email IN (${placeholders}) AND status = 'pending'`,
    )
      .bind(...lower)
      .all<WaitlistRow>();
    targets = results ?? [];
  } else if (count) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, status, token, invite_code, created_at, invited_at
       FROM waitlist WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(count)
      .all<WaitlistRow>();
    targets = results ?? [];
  } else {
    return c.json({ error: 'Provide emails or count' }, 400);
  }

  if (targets.length === 0) return c.json({ ok: true, sent: 0 });

  const origin = new URL(c.req.url).origin;
  const now = Date.now();
  let sent = 0;
  const errors: string[] = [];

  for (const entry of targets) {
    const code = generateCode();
    const inviteUrl = `${origin}/invite/${encodeURIComponent(code)}`;

    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO invite_codes (code, created_by, wave, max_uses, used_count, note, expires_at, created_at)
           VALUES (?, ?, ?, 1, 0, ?, NULL, ?)`,
        ).bind(code, adminUser!.id, wave, `waitlist:${entry.email}`, now),
        c.env.DB.prepare(
          `UPDATE waitlist SET status = 'invited', invite_code = ?, invited_at = ? WHERE id = ?`,
        ).bind(code, now, entry.id),
      ]);

      const result = await sendBetaInviteEmail(c.env, { to: entry.email, inviteUrl });
      logEmailResult(result, 'beta_invite', entry.email);
      if (result.ok) sent++;
      else errors.push(entry.email);
    } catch (err) {
      errors.push(entry.email);
      console.error('[invites] failed to send invite', { email: entry.email, error: String(err) });
    }
  }

  return c.json({ ok: true, sent, errors: errors.length > 0 ? errors : undefined });
});
