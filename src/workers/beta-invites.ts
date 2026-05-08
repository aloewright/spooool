// ALO-181: beta invite system + waitlist.
//
// Public surface:
//   * POST  /api/waitlist           — capture email pre-launch.
//   * GET   /api/waitlist?email=    — look up an entry's position + status.
//   * POST  /api/invites/redeem     — redeem a code with an email; idempotent
//                                     for the same (code, email) pair.
//   * GET   /api/invites/:code      — validate a code without consuming a use.
//
// Admin surface (gated by isAdmin via roles.ts):
//   * GET    /api/admin/waitlist
//   * POST   /api/admin/waitlist/invite   — mint codes for a wave or for a
//                                            list of waitlist ids.
//   * GET    /api/admin/invites
//   * POST   /api/admin/invites           — create one or more codes.
//   * DELETE /api/admin/invites/:id       — disable a code (soft).
//
// Code generation: 8-char Crockford-ish base32 (no I/L/O/U) with a "SPOOL-"
// prefix so codes are easy to read and unambiguous in support tickets. We
// retry on UNIQUE collisions; collision rate is negligible at our scale.
//
// Quota enforcement: the redeem path uses a guarded UPDATE
// (`SET uses = uses + 1 WHERE uses < max_uses AND disabled_at IS NULL`) so
// concurrent redeems can't oversubscribe — D1 serializes per-row writes.

import { Hono } from 'hono';
import { z } from 'zod';
import { isAdmin } from './roles';

export interface BetaInviteEnv {
  DB: D1Database;
  ADMIN_EMAILS?: string;
}

type SessionUser = { id: string; email: string; name: string } | null;
type Variables = { user: SessionUser };

const CODE_PREFIX = 'SPOOL-';
const CODE_BODY_LEN = 8;
// Crockford base32 minus the visually-ambiguous chars (no I, L, O, U).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateInviteCode(): string {
  let body = '';
  const buf = new Uint8Array(CODE_BODY_LEN);
  crypto.getRandomValues(buf);
  for (let i = 0; i < CODE_BODY_LEN; i++) {
    const byte = buf[i] ?? 0;
    body += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `${CODE_PREFIX}${body}`;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const waitlistSignupSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120).optional(),
  source: z.string().max(60).optional(),
  referrer: z.string().max(500).optional(),
});

const waitlistLookupSchema = z.object({
  email: z.string().email().max(254),
});

const redeemSchema = z.object({
  code: z.string().min(4).max(40),
  email: z.string().email().max(254),
});

const createInvitesSchema = z.object({
  count: z.number().int().min(1).max(500).optional().default(1),
  maxUses: z.number().int().min(1).max(10000).optional().default(1),
  wave: z.number().int().min(0).max(1000).optional().default(0),
  expiresAt: z.number().int().positive().optional(),
  notes: z.string().max(500).optional().default(''),
});

const inviteWaveSchema = z
  .object({
    wave: z.number().int().min(1).max(1000).optional(),
    ids: z.array(z.string().min(1).max(64)).max(500).optional(),
    maxUses: z.number().int().min(1).max(100).optional().default(1),
    expiresAt: z.number().int().positive().optional(),
  })
  .refine((v) => v.wave !== undefined || (v.ids && v.ids.length > 0), {
    message: 'Provide either wave or ids',
  });

interface WaitlistRow {
  id: string;
  email: string;
  name: string | null;
  source: string | null;
  referrer: string | null;
  wave: number;
  invited_at: number | null;
  invite_code_id: string | null;
  signed_up_user_id: string | null;
  created_at: number;
  updated_at: number;
}

interface InviteCodeRow {
  id: string;
  code: string;
  max_uses: number;
  uses: number;
  wave: number;
  expires_at: number | null;
  created_by_user_id: string | null;
  notes: string;
  disabled_at: number | null;
  created_at: number;
}

export const betaInviteRoutes = new Hono<{
  Bindings: BetaInviteEnv;
  Variables: Variables;
}>();

// --- public: waitlist ------------------------------------------------------

betaInviteRoutes.post('/api/waitlist', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = waitlistSignupSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid waitlist signup', details: parsed.error.flatten() }, 400);
  }
  const email = normalizeEmail(parsed.data.email);
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    'SELECT id, created_at, wave FROM waitlist WHERE email = ?',
  )
    .bind(email)
    .first<{ id: string; created_at: number; wave: number }>();
  if (existing) {
    const position = await waitlistPosition(c.env, existing.created_at);
    return c.json({
      id: existing.id,
      email,
      alreadyOnList: true,
      position,
      wave: existing.wave,
    });
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO waitlist (id, email, name, source, referrer, wave, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      id,
      email,
      parsed.data.name ?? null,
      parsed.data.source ?? null,
      parsed.data.referrer ?? null,
      now,
      now,
    )
    .run();

  const position = await waitlistPosition(c.env, now);
  return c.json({ id, email, alreadyOnList: false, position, wave: 0 }, 201);
});

betaInviteRoutes.get('/api/waitlist', async (c) => {
  const parsed = waitlistLookupSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid waitlist lookup', details: parsed.error.flatten() }, 400);
  }
  const email = normalizeEmail(parsed.data.email);
  const row = await c.env.DB.prepare(
    `SELECT id, email, wave, invited_at, signed_up_user_id, created_at
     FROM waitlist WHERE email = ?`,
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      wave: number;
      invited_at: number | null;
      signed_up_user_id: string | null;
      created_at: number;
    }>();
  if (!row) return c.json({ error: 'Not on waitlist' }, 404);
  const position = await waitlistPosition(c.env, row.created_at);
  return c.json({
    id: row.id,
    email: row.email,
    wave: row.wave,
    invited: row.invited_at != null,
    signedUp: row.signed_up_user_id != null,
    position,
    createdAt: row.created_at,
  });
});

async function waitlistPosition(env: BetaInviteEnv, createdAt: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM waitlist
     WHERE created_at <= ? AND signed_up_user_id IS NULL`,
  )
    .bind(createdAt)
    .first<{ n: number }>();
  return Number(row?.n ?? 1);
}

// --- public: invite codes --------------------------------------------------

betaInviteRoutes.get('/api/invites/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (!code || code.length > 40) return c.json({ error: 'Invalid code' }, 400);
  const row = await loadCode(c.env, code);
  if (!row) return c.json({ error: 'Code not found', valid: false }, 404);
  const reason = invalidReason(row, Date.now());
  if (reason) return c.json({ valid: false, reason }, 200);
  return c.json({
    valid: true,
    code: row.code,
    wave: row.wave,
    remaining: row.max_uses - row.uses,
    expiresAt: row.expires_at,
  });
});

betaInviteRoutes.post('/api/invites/redeem', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid redeem payload', details: parsed.error.flatten() }, 400);
  }
  const code = normalizeCode(parsed.data.code);
  const email = normalizeEmail(parsed.data.email);
  const now = Date.now();

  const codeRow = await loadCode(c.env, code);
  if (!codeRow) return c.json({ error: 'Code not found' }, 404);
  const reason = invalidReason(codeRow, now);
  if (reason) return c.json({ error: reason }, 409);

  // Idempotent: the same email re-redeeming the same code returns the
  // existing redemption row without consuming another use.
  const prior = await c.env.DB.prepare(
    'SELECT id, created_at FROM invite_redemptions WHERE invite_code_id = ? AND email = ?',
  )
    .bind(codeRow.id, email)
    .first<{ id: string; created_at: number }>();
  if (prior) {
    return c.json({
      ok: true,
      alreadyRedeemed: true,
      redemptionId: prior.id,
      code: codeRow.code,
      wave: codeRow.wave,
    });
  }

  // Guarded increment — D1 serializes writes per row, so two concurrent
  // redeems can't both pass the `uses < max_uses` check.
  const update = await c.env.DB.prepare(
    `UPDATE invite_codes
     SET uses = uses + 1
     WHERE id = ? AND uses < max_uses AND disabled_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(codeRow.id, now)
    .run();

  // D1's `meta.changes` is the canonical row-changed signal; some shims also
  // expose `changes` at the top level. Treat any positive value as success.
  const meta = (update as unknown as { meta?: { changes?: number }; changes?: number }).meta;
  const changes = meta?.changes ?? (update as { changes?: number }).changes ?? 0;
  if (changes < 1) {
    return c.json({ error: 'Code is fully redeemed' }, 409);
  }

  const redemptionId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO invite_redemptions (id, invite_code_id, email, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(redemptionId, codeRow.id, email, now)
    .run();

  // If the redeemer is on the waitlist, mark them as invited so admin
  // dashboards can see who came in via which code.
  await c.env.DB.prepare(
    `UPDATE waitlist
     SET invited_at = COALESCE(invited_at, ?), invite_code_id = COALESCE(invite_code_id, ?), updated_at = ?
     WHERE email = ?`,
  )
    .bind(now, codeRow.id, now, email)
    .run();

  return c.json(
    {
      ok: true,
      alreadyRedeemed: false,
      redemptionId,
      code: codeRow.code,
      wave: codeRow.wave,
    },
    201,
  );
});

async function loadCode(env: BetaInviteEnv, code: string): Promise<InviteCodeRow | null> {
  return await env.DB.prepare(
    `SELECT id, code, max_uses, uses, wave, expires_at, created_by_user_id,
            notes, disabled_at, created_at
     FROM invite_codes WHERE code = ?`,
  )
    .bind(code)
    .first<InviteCodeRow>();
}

function invalidReason(row: InviteCodeRow, now: number): string | null {
  if (row.disabled_at != null) return 'disabled';
  if (row.expires_at != null && row.expires_at <= now) return 'expired';
  if (row.uses >= row.max_uses) return 'exhausted';
  return null;
}

// --- admin: waitlist + invites --------------------------------------------

for (const path of [
  '/api/admin/waitlist',
  '/api/admin/waitlist/*',
  '/api/admin/invites',
  '/api/admin/invites/*',
]) {
  betaInviteRoutes.use(path, async (c, next) => {
    const user = c.get('user');
    if (!(await isAdmin(c.env, user))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  });
}

betaInviteRoutes.get('/api/admin/waitlist', async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const wave = c.req.query('wave');
  const where = wave === undefined ? '' : 'WHERE wave = ?';
  const binds = wave === undefined ? [limit, offset] : [Number(wave), limit, offset];
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, name, source, referrer, wave, invited_at, invite_code_id,
            signed_up_user_id, created_at, updated_at
     FROM waitlist ${where}
     ORDER BY created_at ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...binds)
    .all<WaitlistRow>();
  const total = await c.env.DB.prepare(
    wave === undefined
      ? 'SELECT COUNT(*) AS n FROM waitlist'
      : 'SELECT COUNT(*) AS n FROM waitlist WHERE wave = ?',
  )
    .bind(...(wave === undefined ? [] : [Number(wave)]))
    .first<{ n: number }>();
  return c.json({
    total: Number(total?.n ?? 0),
    entries: (results ?? []).map(rowToWaitlist),
  });
});

betaInviteRoutes.post('/api/admin/waitlist/invite', async (c) => {
  const admin = c.get('user') as SessionUser;
  if (!admin) return c.json({ error: 'Unauthorized' }, 401);
  const json = await c.req.json().catch(() => null);
  const parsed = inviteWaveSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid invite payload', details: parsed.error.flatten() }, 400);
  }
  const now = Date.now();
  const { wave, ids, maxUses, expiresAt } = parsed.data;

  let entries: WaitlistRow[];
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, name, source, referrer, wave, invited_at, invite_code_id,
              signed_up_user_id, created_at, updated_at
       FROM waitlist WHERE id IN (${placeholders}) AND invited_at IS NULL`,
    )
      .bind(...ids)
      .all<WaitlistRow>();
    entries = results ?? [];
  } else {
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, name, source, referrer, wave, invited_at, invite_code_id,
              signed_up_user_id, created_at, updated_at
       FROM waitlist WHERE wave = ? AND invited_at IS NULL
       ORDER BY created_at ASC`,
    )
      .bind(wave ?? 0)
      .all<WaitlistRow>();
    entries = results ?? [];
  }

  const targetWave = wave ?? 0;
  const minted: { waitlistId: string; email: string; codeId: string; code: string }[] = [];
  for (const entry of entries) {
    const codeId = crypto.randomUUID();
    const codeStr = await mintUniqueCode(c.env);
    await c.env.DB.prepare(
      `INSERT INTO invite_codes (id, code, max_uses, uses, wave, expires_at,
                                 created_by_user_id, notes, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        codeId,
        codeStr,
        maxUses,
        targetWave,
        expiresAt ?? null,
        admin.id,
        `wave invite for ${entry.email}`,
        now,
      )
      .run();
    await c.env.DB.prepare(
      `UPDATE waitlist
       SET wave = ?, invited_at = ?, invite_code_id = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(targetWave, now, codeId, now, entry.id)
      .run();
    minted.push({ waitlistId: entry.id, email: entry.email, codeId, code: codeStr });
  }

  return c.json({ wave: targetWave, invited: minted }, 201);
});

betaInviteRoutes.get('/api/admin/invites', async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const { results } = await c.env.DB.prepare(
    `SELECT id, code, max_uses, uses, wave, expires_at, created_by_user_id,
            notes, disabled_at, created_at
     FROM invite_codes
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<InviteCodeRow>();
  return c.json({ codes: (results ?? []).map(rowToInvite) });
});

betaInviteRoutes.post('/api/admin/invites', async (c) => {
  const admin = c.get('user') as SessionUser;
  if (!admin) return c.json({ error: 'Unauthorized' }, 401);
  const json = await c.req.json().catch(() => null);
  const parsed = createInvitesSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid invite payload', details: parsed.error.flatten() }, 400);
  }
  const { count, maxUses, wave, expiresAt, notes } = parsed.data;
  const now = Date.now();
  const minted: { id: string; code: string }[] = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const code = await mintUniqueCode(c.env);
    await c.env.DB.prepare(
      `INSERT INTO invite_codes (id, code, max_uses, uses, wave, expires_at,
                                 created_by_user_id, notes, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(id, code, maxUses, wave, expiresAt ?? null, admin.id, notes, now)
      .run();
    minted.push({ id, code });
  }
  return c.json({ count: minted.length, codes: minted, wave, maxUses }, 201);
});

betaInviteRoutes.delete('/api/admin/invites/:id', async (c) => {
  const id = c.req.param('id');
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT id, code FROM invite_codes WHERE id = ? AND disabled_at IS NULL`,
  )
    .bind(id)
    .first<{ id: string; code: string }>();
  if (!row) return c.json({ error: 'Code not found' }, 404);
  await c.env.DB.prepare('UPDATE invite_codes SET disabled_at = ? WHERE id = ?')
    .bind(now, id)
    .run();
  return c.json({ id: row.id, code: row.code, disabled: true });
});

async function mintUniqueCode(env: BetaInviteEnv): Promise<string> {
  // Collision rate at 32^8 = ~1.1e12 codes is negligible, but a cheap retry
  // loop costs nothing and lets us guarantee uniqueness even at scale.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateInviteCode();
    const exists = await env.DB.prepare('SELECT 1 FROM invite_codes WHERE code = ?')
      .bind(candidate)
      .first<{ '1': number }>();
    if (!exists) return candidate;
  }
  throw new Error('Failed to mint a unique invite code after 5 attempts');
}

function rowToWaitlist(r: WaitlistRow) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    source: r.source,
    referrer: r.referrer,
    wave: r.wave,
    invitedAt: r.invited_at,
    inviteCodeId: r.invite_code_id,
    signedUpUserId: r.signed_up_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToInvite(r: InviteCodeRow) {
  return {
    id: r.id,
    code: r.code,
    maxUses: r.max_uses,
    uses: r.uses,
    wave: r.wave,
    expiresAt: r.expires_at,
    createdByUserId: r.created_by_user_id,
    notes: r.notes,
    disabledAt: r.disabled_at,
    createdAt: r.created_at,
  };
}
