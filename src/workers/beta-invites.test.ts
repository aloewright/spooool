import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  betaInviteRoutes,
  generateInviteCode,
  normalizeCode,
  normalizeEmail,
  type BetaInviteEnv,
} from './beta-invites';

interface WaitlistEntry {
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

interface InviteCodeEntry {
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

interface RedemptionEntry {
  id: string;
  invite_code_id: string;
  email: string;
  user_id: string | null;
  created_at: number;
}

interface RoleEntry {
  user_id: string;
  role: string;
}

interface FakeStore {
  waitlist: WaitlistEntry[];
  invites: InviteCodeEntry[];
  redemptions: RedemptionEntry[];
  roles: RoleEntry[];
  users: Map<string, { id: string; email: string }>;
}

function makeStore(): FakeStore {
  return {
    waitlist: [],
    invites: [],
    redemptions: [],
    roles: [],
    users: new Map([['u-admin', { id: 'u-admin', email: 'admin@spooool.com' }]]),
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function fakeDB(store: FakeStore): D1Database {
  const stmt = (sql: string): PreparedStmt => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api: PreparedStmt = {
      bind(...v: unknown[]) {
        bound = v;
        return api;
      },
      async first<T>(): Promise<T | null> {
        // --- roles bootstrap fallback ---
        if (trimmed.startsWith('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?')) {
          const found = store.roles.find((r) => r.user_id === bound[0] && r.role === bound[1]);
          return found ? ({ '1': 1 } as T) : null;
        }
        if (trimmed.startsWith("SELECT 1 FROM user_roles WHERE role = 'admin' LIMIT 1")) {
          const found = store.roles.find((r) => r.role === 'admin');
          return found ? ({ '1': 1 } as T) : null;
        }

        // --- waitlist ---
        if (trimmed.startsWith('SELECT id, created_at, wave FROM waitlist WHERE email = ?')) {
          const e = store.waitlist.find((w) => w.email === bound[0]);
          if (!e) return null;
          return { id: e.id, created_at: e.created_at, wave: e.wave } as T;
        }
        if (
          trimmed.startsWith(
            'SELECT id, email, wave, invited_at, signed_up_user_id, created_at FROM waitlist WHERE email = ?',
          )
        ) {
          const e = store.waitlist.find((w) => w.email === bound[0]);
          if (!e) return null;
          return {
            id: e.id,
            email: e.email,
            wave: e.wave,
            invited_at: e.invited_at,
            signed_up_user_id: e.signed_up_user_id,
            created_at: e.created_at,
          } as T;
        }
        if (
          trimmed.startsWith(
            'SELECT COUNT(*) AS n FROM waitlist WHERE created_at <= ? AND signed_up_user_id IS NULL',
          )
        ) {
          const ts = bound[0] as number;
          return {
            n: store.waitlist.filter((w) => w.created_at <= ts && w.signed_up_user_id == null)
              .length,
          } as T;
        }
        if (trimmed.startsWith('SELECT COUNT(*) AS n FROM waitlist WHERE wave = ?')) {
          return { n: store.waitlist.filter((w) => w.wave === bound[0]).length } as T;
        }
        if (trimmed.startsWith('SELECT COUNT(*) AS n FROM waitlist')) {
          return { n: store.waitlist.length } as T;
        }

        // --- invite codes ---
        if (trimmed.startsWith('SELECT id, code, max_uses, uses, wave, expires_at')) {
          const c = store.invites.find((i) => i.code === bound[0]);
          return (c ?? null) as T | null;
        }
        if (trimmed.startsWith('SELECT 1 FROM invite_codes WHERE code = ?')) {
          const c = store.invites.find((i) => i.code === bound[0]);
          return c ? ({ '1': 1 } as T) : null;
        }
        if (
          trimmed.startsWith(
            'SELECT id, code FROM invite_codes WHERE id = ? AND disabled_at IS NULL',
          )
        ) {
          const c = store.invites.find((i) => i.id === bound[0] && i.disabled_at == null);
          return c ? ({ id: c.id, code: c.code } as T) : null;
        }

        // --- redemptions ---
        if (
          trimmed.startsWith(
            'SELECT id, created_at FROM invite_redemptions WHERE invite_code_id = ? AND email = ?',
          )
        ) {
          const r = store.redemptions.find(
            (rr) => rr.invite_code_id === bound[0] && rr.email === bound[1],
          );
          return r ? ({ id: r.id, created_at: r.created_at } as T) : null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (trimmed.startsWith('SELECT id, email, name, source, referrer, wave, invited_at')) {
          // /api/admin/waitlist or admin/waitlist/invite
          let rows = [...store.waitlist];
          if (/WHERE id IN \(/.test(trimmed)) {
            rows = rows.filter((r) => bound.slice(0, -0).includes(r.id) && r.invited_at == null);
            return { results: rows as unknown as T[] };
          }
          if (/WHERE wave = \? AND invited_at IS NULL/.test(trimmed)) {
            rows = rows.filter((r) => r.wave === bound[0] && r.invited_at == null);
            rows.sort((a, b) => a.created_at - b.created_at);
            return { results: rows as unknown as T[] };
          }
          if (/WHERE wave = \?/.test(trimmed)) {
            rows = rows.filter((r) => r.wave === bound[0]);
            const limit = bound[1] as number;
            const offset = bound[2] as number;
            rows.sort((a, b) => a.created_at - b.created_at);
            return { results: rows.slice(offset, offset + limit) as unknown as T[] };
          }
          // No wave filter: order by created_at ASC, paged
          const limit = bound[0] as number;
          const offset = bound[1] as number;
          rows.sort((a, b) => a.created_at - b.created_at);
          return { results: rows.slice(offset, offset + limit) as unknown as T[] };
        }
        if (
          trimmed.startsWith(
            'SELECT id, code, max_uses, uses, wave, expires_at, created_by_user_id',
          )
        ) {
          const limit = bound[0] as number;
          const offset = bound[1] as number;
          const rows = [...store.invites].sort((a, b) => b.created_at - a.created_at);
          return { results: rows.slice(offset, offset + limit) as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (trimmed.startsWith('INSERT INTO waitlist')) {
          store.waitlist.push({
            id: bound[0] as string,
            email: bound[1] as string,
            name: (bound[2] as string | null) ?? null,
            source: (bound[3] as string | null) ?? null,
            referrer: (bound[4] as string | null) ?? null,
            wave: 0,
            invited_at: null,
            invite_code_id: null,
            signed_up_user_id: null,
            created_at: bound[5] as number,
            updated_at: bound[6] as number,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (trimmed.startsWith('INSERT INTO invite_codes')) {
          store.invites.push({
            id: bound[0] as string,
            code: bound[1] as string,
            max_uses: bound[2] as number,
            uses: 0,
            wave: bound[3] as number,
            expires_at: (bound[4] as number | null) ?? null,
            created_by_user_id: (bound[5] as string | null) ?? null,
            notes: (bound[6] as string) ?? '',
            disabled_at: null,
            created_at: bound[7] as number,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (trimmed.startsWith('INSERT INTO invite_redemptions')) {
          store.redemptions.push({
            id: bound[0] as string,
            invite_code_id: bound[1] as string,
            email: bound[2] as string,
            user_id: null,
            created_at: bound[3] as number,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (
          trimmed.startsWith(
            'UPDATE invite_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses',
          )
        ) {
          const id = bound[0] as string;
          const now = bound[1] as number;
          const c = store.invites.find((i) => i.id === id);
          if (
            !c ||
            c.disabled_at != null ||
            c.uses >= c.max_uses ||
            (c.expires_at != null && c.expires_at <= now)
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          c.uses += 1;
          return { success: true, meta: { changes: 1 } };
        }
        if (trimmed.startsWith('UPDATE invite_codes SET disabled_at = ?')) {
          const c = store.invites.find((i) => i.id === bound[1]);
          if (c) c.disabled_at = bound[0] as number;
          return { success: true, meta: { changes: c ? 1 : 0 } };
        }
        if (
          trimmed.startsWith(
            'UPDATE waitlist SET invited_at = COALESCE(invited_at, ?), invite_code_id = COALESCE(invite_code_id, ?)',
          )
        ) {
          const w = store.waitlist.find((x) => x.email === bound[3]);
          if (w) {
            if (w.invited_at == null) w.invited_at = bound[0] as number;
            if (w.invite_code_id == null) w.invite_code_id = bound[1] as string;
            w.updated_at = bound[2] as number;
          }
          return { success: true, meta: { changes: w ? 1 : 0 } };
        }
        if (
          trimmed.startsWith(
            'UPDATE waitlist SET wave = ?, invited_at = ?, invite_code_id = ?, updated_at = ? WHERE id = ?',
          )
        ) {
          const w = store.waitlist.find((x) => x.id === bound[4]);
          if (w) {
            w.wave = bound[0] as number;
            w.invited_at = bound[1] as number;
            w.invite_code_id = bound[2] as string;
            w.updated_at = bound[3] as number;
          }
          return { success: true, meta: { changes: w ? 1 : 0 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
    return api;
  };
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

type AppCtx = { Variables: { user: { id: string; email: string; name: string } | null } };

function makeApp(store: FakeStore, opts?: { asUserId?: string | null }) {
  const app = new Hono<AppCtx>();
  app.use('*', async (c, next) => {
    const id = opts?.asUserId === undefined ? null : opts.asUserId;
    if (id == null) {
      c.set('user', null);
    } else {
      const u = store.users.get(id);
      c.set('user', u ? { id: u.id, email: u.email, name: 'A' } : null);
    }
    await next();
  });
  app.route('/', betaInviteRoutes);
  const env = { DB: fakeDB(store), ADMIN_EMAILS: 'admin@spooool.com' } as BetaInviteEnv;
  return {
    async post(path: string, body: unknown) {
      return app.fetch(
        new Request(`http://t${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env as never,
      );
    },
    async del(path: string) {
      return app.fetch(new Request(`http://t${path}`, { method: 'DELETE' }), env as never);
    },
    async get(path: string) {
      return app.fetch(new Request(`http://t${path}`), env as never);
    },
  };
}

describe('helpers', () => {
  it('generateInviteCode produces SPOOL- prefix and only allowed chars', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateInviteCode();
      expect(c).toMatch(/^SPOOL-[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });
  it('normalizeEmail trims and lowercases', () => {
    expect(normalizeEmail('  FoO@BAR.COM  ')).toBe('foo@bar.com');
  });
  it('normalizeCode trims and uppercases', () => {
    expect(normalizeCode(' spool-abc123 ')).toBe('SPOOL-ABC123');
  });
});

describe('POST /api/waitlist', () => {
  it('captures a new email and returns position 1', async () => {
    const store = makeStore();
    const app = makeApp(store, { asUserId: null });
    const res = await app.post('/api/waitlist', { email: 'first@x.com' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { position: number; alreadyOnList: boolean; email: string };
    expect(body.alreadyOnList).toBe(false);
    expect(body.position).toBe(1);
    expect(body.email).toBe('first@x.com');
    expect(store.waitlist.length).toBe(1);
  });

  it('is idempotent — same email returns alreadyOnList', async () => {
    const store = makeStore();
    const app = makeApp(store);
    await app.post('/api/waitlist', { email: 'a@x.com' });
    const second = await app.post('/api/waitlist', { email: 'a@x.com' });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { alreadyOnList: boolean };
    expect(body.alreadyOnList).toBe(true);
    expect(store.waitlist.length).toBe(1);
  });

  it('rejects invalid email with 400', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const res = await app.post('/api/waitlist', { email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/waitlist', () => {
  it('returns the entry for a known email', async () => {
    const store = makeStore();
    const app = makeApp(store);
    await app.post('/api/waitlist', { email: 'me@x.com' });
    const res = await app.get('/api/waitlist?email=me@x.com');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; signedUp: boolean; invited: boolean };
    expect(body.email).toBe('me@x.com');
    expect(body.invited).toBe(false);
    expect(body.signedUp).toBe(false);
  });
  it('returns 404 for an unknown email', async () => {
    const store = makeStore();
    const app = makeApp(store);
    const res = await app.get('/api/waitlist?email=nobody@x.com');
    expect(res.status).toBe(404);
  });
});

describe('admin invite + waitlist flow', () => {
  it('admin can mint invite codes and they validate', async () => {
    const store = makeStore();
    const app = makeApp(store, { asUserId: 'u-admin' });
    const created = await app.post('/api/admin/invites', { count: 3, maxUses: 2 });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { codes: { code: string }[]; count: number };
    expect(body.count).toBe(3);
    expect(store.invites.length).toBe(3);

    const validation = await app.get(`/api/invites/${body.codes[0]!.code}`);
    expect(validation.status).toBe(200);
    const v = (await validation.json()) as { valid: boolean; remaining: number };
    expect(v.valid).toBe(true);
    expect(v.remaining).toBe(2);
  });

  it('non-admin gets 403 from /api/admin/invites', async () => {
    const store = makeStore();
    // Seed an admin in the table so bootstrap fallback is disabled
    store.users.set('u-other', { id: 'u-other', email: 'other@x.com' });
    store.roles.push({ user_id: 'u-admin', role: 'admin' });
    const app = makeApp(store, { asUserId: 'u-other' });
    const res = await app.post('/api/admin/invites', { count: 1 });
    expect(res.status).toBe(403);
  });

  it('admin invite for a wave mints codes and marks waitlist invited', async () => {
    const store = makeStore();
    // Two waitlist entries on wave 1
    store.waitlist.push(
      {
        id: 'w1',
        email: 'a@x.com',
        name: null,
        source: null,
        referrer: null,
        wave: 1,
        invited_at: null,
        invite_code_id: null,
        signed_up_user_id: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'w2',
        email: 'b@x.com',
        name: null,
        source: null,
        referrer: null,
        wave: 1,
        invited_at: null,
        invite_code_id: null,
        signed_up_user_id: null,
        created_at: 2,
        updated_at: 2,
      },
    );
    const app = makeApp(store, { asUserId: 'u-admin' });
    const res = await app.post('/api/admin/waitlist/invite', { wave: 1 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invited: { email: string }[] };
    expect(body.invited.length).toBe(2);
    expect(store.invites.length).toBe(2);
    expect(store.waitlist.every((w) => w.invited_at != null)).toBe(true);
  });
});

describe('redeem flow', () => {
  it('redeems a code, increments uses, and is idempotent for same email', async () => {
    const store = makeStore();
    const adminApp = makeApp(store, { asUserId: 'u-admin' });
    const created = await adminApp.post('/api/admin/invites', { count: 1, maxUses: 2 });
    const { codes } = (await created.json()) as { codes: { code: string }[] };
    const code = codes[0]!.code;

    const publicApp = makeApp(store, { asUserId: null });
    const r1 = await publicApp.post('/api/invites/redeem', { code, email: 'redeem@x.com' });
    expect(r1.status).toBe(201);
    const r1Body = (await r1.json()) as { ok: boolean; alreadyRedeemed: boolean };
    expect(r1Body.ok).toBe(true);
    expect(r1Body.alreadyRedeemed).toBe(false);
    expect(store.invites[0]!.uses).toBe(1);

    const r2 = await publicApp.post('/api/invites/redeem', { code, email: 'redeem@x.com' });
    expect(r2.status).toBe(200);
    const r2Body = (await r2.json()) as { alreadyRedeemed: boolean };
    expect(r2Body.alreadyRedeemed).toBe(true);
    expect(store.invites[0]!.uses).toBe(1);
  });

  it('refuses to redeem an exhausted code', async () => {
    const store = makeStore();
    const adminApp = makeApp(store, { asUserId: 'u-admin' });
    const created = await adminApp.post('/api/admin/invites', { count: 1, maxUses: 1 });
    const { codes } = (await created.json()) as { codes: { code: string }[] };
    const code = codes[0]!.code;

    const publicApp = makeApp(store, { asUserId: null });
    const ok = await publicApp.post('/api/invites/redeem', { code, email: 'a@x.com' });
    expect(ok.status).toBe(201);
    const denied = await publicApp.post('/api/invites/redeem', { code, email: 'b@x.com' });
    expect(denied.status).toBe(409);
  });

  it('refuses to redeem a disabled code', async () => {
    const store = makeStore();
    const adminApp = makeApp(store, { asUserId: 'u-admin' });
    const created = await adminApp.post('/api/admin/invites', { count: 1, maxUses: 5 });
    const { codes } = (await created.json()) as { codes: { code: string; id?: string }[] };
    const codeId = store.invites[0]!.id;
    const disable = await adminApp.del(`/api/admin/invites/${codeId}`);
    expect(disable.status).toBe(200);

    const publicApp = makeApp(store, { asUserId: null });
    const denied = await publicApp.post('/api/invites/redeem', {
      code: codes[0]!.code,
      email: 'c@x.com',
    });
    expect(denied.status).toBe(409);
  });

  it('returns 404 for an unknown code', async () => {
    const store = makeStore();
    const app = makeApp(store, { asUserId: null });
    const res = await app.post('/api/invites/redeem', {
      code: 'SPOOL-NONEXIST',
      email: 'x@x.com',
    });
    expect(res.status).toBe(404);
  });

  it('marks a waitlisted email as invited on redeem', async () => {
    const store = makeStore();
    store.waitlist.push({
      id: 'w-x',
      email: 'wait@x.com',
      name: null,
      source: null,
      referrer: null,
      wave: 0,
      invited_at: null,
      invite_code_id: null,
      signed_up_user_id: null,
      created_at: 1,
      updated_at: 1,
    });
    const adminApp = makeApp(store, { asUserId: 'u-admin' });
    const created = await adminApp.post('/api/admin/invites', { count: 1, maxUses: 5 });
    const { codes } = (await created.json()) as { codes: { code: string }[] };
    const code = codes[0]!.code;

    const publicApp = makeApp(store, { asUserId: null });
    const res = await publicApp.post('/api/invites/redeem', { code, email: 'wait@x.com' });
    expect(res.status).toBe(201);
    expect(store.waitlist[0]!.invited_at).not.toBeNull();
    expect(store.waitlist[0]!.invite_code_id).toBe(store.invites[0]!.id);
  });
});

describe('migrations test extension', () => {
  it('the 0019 migration exists and references waitlist + invite_codes', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sql = fs.readFileSync(
      path.join(__dirname, '../db/migrations/0019_beta_invites.sql'),
      'utf8',
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS waitlist/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS invite_codes/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS invite_redemptions/);
  });
});
