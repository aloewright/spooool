import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  DELETION_GRACE_DAYS,
  DELETION_GRACE_MS,
  accountRoutes,
  cascadeDeleteUser,
  runDeletionSweep,
  type CascadeEnv,
} from './account';

const sendAccountDeletionEmailSpy = vi.fn().mockResolvedValue({ ok: true });

vi.mock('./email', () => ({
  sendAccountDeletionEmail: (env: unknown, args: unknown) =>
    sendAccountDeletionEmailSpy(env as never, args as never),
}));

describe('deletion grace constants', () => {
  it('grace is 30 days in ms', () => {
    expect(DELETION_GRACE_DAYS).toBe(30);
    expect(DELETION_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

interface FakeUser {
  id: string;
  email: string;
  name: string;
  deletion_requested_at: number | null;
  deletion_scheduled_for: number | null;
}

interface FakeStore {
  users: Map<string, FakeUser>;
  videos: Array<{ id: string; user_id: string; r2_key: string }>;
  comments: Array<{ id: string; user_id: string | null }>;
  views: Array<{ user_id: string | null }>;
  subscriptions: Array<{ subscriber_user_id: string; channel_user_id: string }>;
  sessions: Array<{ id: string; userId: string }>;
  accounts: Array<{ id: string; userId: string }>;
  r2Deletes: string[];
  cacheDeletes: string[];
}

function makeStore(): FakeStore {
  return {
    users: new Map([
      [
        'u1',
        {
          id: 'u1',
          email: 'a@b.com',
          name: 'A',
          deletion_requested_at: null,
          deletion_scheduled_for: null,
        },
      ],
    ]),
    videos: [{ id: 'v1', user_id: 'u1', r2_key: 'u1/v1/clip.mp4' }],
    comments: [
      { id: 'c1', user_id: 'u1' },
      { id: 'c2', user_id: 'u2' },
    ],
    views: [{ user_id: 'u1' }, { user_id: null }],
    subscriptions: [
      { subscriber_user_id: 'u1', channel_user_id: 'u2' },
      { subscriber_user_id: 'u2', channel_user_id: 'u3' },
    ],
    sessions: [{ id: 's1', userId: 'u1' }],
    accounts: [{ id: 'a1', userId: 'u1' }],
    r2Deletes: [],
    cacheDeletes: [],
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function fakeR2(deletes: string[]): R2Bucket {
  return { delete: async (k: string) => deletes.push(k) } as unknown as R2Bucket;
}

function fakeKV(deletes: string[]): KVNamespace {
  return { delete: async (k: string) => deletes.push(k), get: async () => null, put: async () => {} } as unknown as KVNamespace;
}

// We override cascadeDeleteUser semantics in this test by using a thin
// in-memory env. Since real D1 batch is opaque, we sanity-check the
// public-facing effects (R2/KV deletes + remaining users in store) via a
// hand-rolled DB that mutates store directly on each run().
function cascadeEnvWithStore(store: FakeStore): CascadeEnv {
  const stmt = (sql: string) => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api = {
      bind(...v: unknown[]) {
        bound = v;
        return api;
      },
      async first() {
        if (trimmed.startsWith('SELECT id, email, name, deletion_requested_at')) {
          const u = store.users.get(bound[0] as string);
          return u ?? null;
        }
        if (trimmed.startsWith('SELECT deletion_scheduled_for FROM user')) {
          const u = store.users.get(bound[0] as string);
          return u ? { deletion_scheduled_for: u.deletion_scheduled_for } : null;
        }
        if (trimmed.startsWith('SELECT id FROM user WHERE email = ?')) {
          for (const u of store.users.values()) {
            if (u.email === bound[0] && u.id !== bound[1]) return { id: u.id };
          }
          return null;
        }
        return null;
      },
      async all() {
        if (trimmed.startsWith('SELECT id, r2_key FROM videos')) {
          return { results: store.videos.filter((v) => v.user_id === bound[0]) };
        }
        if (trimmed.startsWith('SELECT id FROM user WHERE deletion_scheduled_for')) {
          const cutoff = bound[0] as number;
          return {
            results: [...store.users.values()]
              .filter((u) => u.deletion_scheduled_for != null && u.deletion_scheduled_for <= cutoff)
              .map((u) => ({ id: u.id })),
          };
        }
        return { results: [] };
      },
      async run() {
        applyMutation(trimmed, bound, store);
        return { success: true };
      },
    };
    return api as unknown as PreparedStmt;
  };
  return {
    DB: {
      prepare: stmt,
      async batch(statements: PreparedStmt[]) {
        for (const s of statements) {
          await (s as { run: () => Promise<unknown> }).run();
        }
        return [];
      },
    } as unknown as D1Database,
    VIDEOS: fakeR2(store.r2Deletes),
    CACHE: fakeKV(store.cacheDeletes),
  };
}

function applyMutation(sql: string, bound: unknown[], store: FakeStore): void {
  if (sql.startsWith('UPDATE comments SET user_id = NULL')) {
    for (const c of store.comments) if (c.user_id === bound[0]) c.user_id = null;
  } else if (sql.startsWith('DELETE FROM views WHERE user_id')) {
    store.views = store.views.filter((v) => v.user_id !== bound[0]);
  } else if (sql.startsWith('DELETE FROM videos WHERE user_id')) {
    store.videos = store.videos.filter((v) => v.user_id !== bound[0]);
  } else if (sql.startsWith('DELETE FROM subscriptions')) {
    store.subscriptions = store.subscriptions.filter(
      (s) => s.subscriber_user_id !== bound[0] && s.channel_user_id !== bound[1],
    );
  } else if (sql.startsWith('DELETE FROM session WHERE userId')) {
    store.sessions = store.sessions.filter((s) => s.userId !== bound[0]);
  } else if (sql.startsWith('DELETE FROM account WHERE userId')) {
    store.accounts = store.accounts.filter((a) => a.userId !== bound[0]);
  } else if (sql.startsWith('DELETE FROM user WHERE id')) {
    store.users.delete(bound[0] as string);
  } else if (
    sql.startsWith(
      'UPDATE user SET deletion_requested_at = ?, deletion_scheduled_for = ?, updatedAt = ? WHERE id = ?',
    )
  ) {
    const u = store.users.get(bound[3] as string);
    if (u) {
      u.deletion_requested_at = bound[0] as number;
      u.deletion_scheduled_for = bound[1] as number;
    }
  } else if (
    sql.startsWith(
      'UPDATE user SET deletion_requested_at = NULL, deletion_scheduled_for = NULL, updatedAt = ? WHERE id = ?',
    )
  ) {
    const u = store.users.get(bound[1] as string);
    if (u) {
      u.deletion_requested_at = null;
      u.deletion_scheduled_for = null;
    }
  } else if (sql.startsWith('UPDATE user SET email = ?')) {
    const u = store.users.get(bound[2] as string);
    if (u) u.email = bound[0] as string;
  }
}

describe('cascadeDeleteUser', () => {
  it('removes videos from R2, anonymizes comments, deletes views/subs/sessions/accounts/user', async () => {
    const store = makeStore();
    const env = cascadeEnvWithStore(store);
    await cascadeDeleteUser(env, 'u1');

    expect(store.r2Deletes).toContain('u1/v1/clip.mp4');
    expect(store.cacheDeletes).toContain('video:v1:v1');
    expect(store.videos.find((v) => v.user_id === 'u1')).toBeUndefined();
    expect(store.comments.find((c) => c.id === 'c1')?.user_id).toBeNull();
    expect(store.comments.find((c) => c.id === 'c2')?.user_id).toBe('u2'); // untouched
    expect(store.views.length).toBe(1);
    expect(store.sessions.length).toBe(0);
    expect(store.accounts.length).toBe(0);
    expect(store.users.has('u1')).toBe(false);
  });
});

describe('runDeletionSweep', () => {
  it('only sweeps users whose grace window has elapsed', async () => {
    const store = makeStore();
    const u = store.users.get('u1');
    if (!u) throw new Error('seed failed');
    u.deletion_scheduled_for = Date.now() - 1000;
    const env = cascadeEnvWithStore(store);
    const stats = await runDeletionSweep(env);
    expect(stats.length).toBe(1);
    expect(stats[0]?.userId).toBe('u1');
    expect(store.users.has('u1')).toBe(false);
  });

  it('leaves users whose grace window is still in the future', async () => {
    const store = makeStore();
    const u = store.users.get('u1');
    if (!u) throw new Error('seed failed');
    u.deletion_scheduled_for = Date.now() + 24 * 60 * 60 * 1000;
    const env = cascadeEnvWithStore(store);
    const stats = await runDeletionSweep(env);
    expect(stats.length).toBe(0);
    expect(store.users.has('u1')).toBe(true);
  });
});

// --- Cancel-window logic via the real Hono routes ---

type AccountCtx = {
  Variables: { user: { id: string; email: string; name: string } | null };
};

function userApp(store: FakeStore, asUser: { id: string } | null) {
  const app = new Hono<AccountCtx>();
  app.use('*', async (c, next) => {
    if (asUser) {
      const u = store.users.get(asUser.id);
      c.set('user', u ? { id: u.id, email: u.email, name: u.name } : null);
    } else {
      c.set('user', null);
    }
    await next();
  });
  app.route('/', accountRoutes);
  return {
    async post(path: string, body?: unknown) {
      return app.fetch(
        new Request(`http://t${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        }),
        cascadeEnvWithStore(store) as never,
      );
    },
    async get(path: string) {
      return app.fetch(new Request(`http://t${path}`), cascadeEnvWithStore(store) as never);
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/account/earnings — D1-backed year-to-date earnings
// ---------------------------------------------------------------------------

interface EarningsDBOpts {
  polarOrgId?: string | null;
  polarStatus?: string;
  grossCents?: number;
  netPaidCents?: number;
}

function earningsApp(opts: EarningsDBOpts = {}, asUser: { id: string } | null = { id: 'u1' }) {
  const {
    polarOrgId = null,
    polarStatus = 'active',
    grossCents = 0,
    netPaidCents = 0,
  } = opts;

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...v: unknown[]) {
          bound = v;
          return stmt;
        },
        async first() {
          void bound;
          if (sql.includes('polar_organization_id') && sql.includes('FROM user')) {
            return { polar_organization_id: polarOrgId, polar_account_status: polarStatus };
          }
          if (sql.includes('FROM creator_earnings')) {
            return { gross: grossCents };
          }
          if (sql.includes('FROM creator_payouts')) {
            return { total: netPaidCents };
          }
          return null;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;

  type EarningsCtx = { Variables: { user: { id: string; email: string; name: string } | null } };
  const app = new Hono<EarningsCtx>();
  app.use('*', async (c, next) => {
    c.set('user', asUser ? { id: asUser.id, email: 'a@b.com', name: 'A' } : null);
    await next();
  });
  app.route('/', accountRoutes);
  return (path: string) => app.fetch(new Request(`http://t${path}`), { DB: db } as never);
}

describe('GET /api/account/earnings', () => {
  it('returns 401 when not signed in', async () => {
    const req = earningsApp({}, null);
    const res = await req('/api/account/earnings');
    expect(res.status).toBe(401);
  });

  it('returns zero earnings as numbers (not null) when creator has no transactions', async () => {
    const req = earningsApp({ grossCents: 0, netPaidCents: 0 });
    const res = await req('/api/account/earnings');
    expect(res.status).toBe(200);
    const body = await res.json() as { grossEarningsUsd: number; netPayoutsUsd: number };
    expect(body.grossEarningsUsd).toBe(0);
    expect(body.netPayoutsUsd).toBe(0);
  });

  it('converts cents to dollars correctly', async () => {
    const req = earningsApp({ grossCents: 15099, netPaidCents: 8500 });
    const res = await req('/api/account/earnings');
    expect(res.status).toBe(200);
    const body = await res.json() as { grossEarningsUsd: number; netPayoutsUsd: number };
    expect(body.grossEarningsUsd).toBeCloseTo(150.99);
    expect(body.netPayoutsUsd).toBeCloseTo(85);
  });

  it('includes polar status and current year', async () => {
    const req = earningsApp({ polarStatus: 'active', polarOrgId: 'org_123' });
    const res = await req('/api/account/earnings');
    const body = await res.json() as {
      year: number;
      polar: { accountStatus: string; organizationId: string | null; needsOnboarding: boolean };
    };
    expect(body.year).toBe(new Date().getUTCFullYear());
    expect(body.polar.accountStatus).toBe('active');
    expect(body.polar.needsOnboarding).toBe(false);
    expect(body.polar.organizationId).toBe('org_123');
  });

  it('sets needsOnboarding true when not yet active', async () => {
    const req = earningsApp({ polarStatus: 'not_connected' });
    const res = await req('/api/account/earnings');
    const body = await res.json() as { polar: { needsOnboarding: boolean } };
    expect(body.polar.needsOnboarding).toBe(true);
  });
});

describe('account delete + cancel window', () => {
  it('schedules deletion 30 days out', async () => {
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    const before = Date.now();
    const res = await app.post('/api/account/delete');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { deletionScheduledFor: number; graceDays: number };
    expect(data.graceDays).toBe(30);
    expect(data.deletionScheduledFor).toBeGreaterThanOrEqual(before + DELETION_GRACE_MS - 1000);
  });

  it('cancel within window clears the deletion fields', async () => {
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    await app.post('/api/account/delete');
    const res = await app.post('/api/account/delete/cancel');
    expect(res.status).toBe(200);
    const u = store.users.get('u1');
    expect(u?.deletion_scheduled_for).toBeNull();
    expect(u?.deletion_requested_at).toBeNull();
  });

  it('cancel after window is rejected with 410', async () => {
    const store = makeStore();
    const u = store.users.get('u1');
    if (!u) throw new Error('seed failed');
    u.deletion_requested_at = Date.now() - DELETION_GRACE_MS - 1000;
    u.deletion_scheduled_for = Date.now() - 1000;
    const app = userApp(store, { id: 'u1' });
    const res = await app.post('/api/account/delete/cancel');
    expect(res.status).toBe(410);
  });

  it('cancel without a pending deletion is rejected with 400', async () => {
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    const res = await app.post('/api/account/delete/cancel');
    expect(res.status).toBe(400);
  });

  it('unauthenticated callers get 401', async () => {
    const store = makeStore();
    const app = userApp(store, null);
    expect((await app.post('/api/account/delete')).status).toBe(401);
    expect((await app.post('/api/account/delete/cancel')).status).toBe(401);
    expect((await app.get('/api/account')).status).toBe(401);
  });

  it('sends the account-deletion confirmation email on delete', async () => {
    sendAccountDeletionEmailSpy.mockClear();
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    await app.post('/api/account/delete');

    expect(sendAccountDeletionEmailSpy).toHaveBeenCalledOnce();
    const args = sendAccountDeletionEmailSpy.mock.calls[0]?.[1] as {
      to: string;
      name: string;
      deletionDate: string;
      cancelUrl: string;
    };
    expect(args.to).toBe('a@b.com');
    expect(args.name).toBe('A');
    expect(args.deletionDate).toMatch(/\d{4}/);
    expect(args.cancelUrl).toBe('http://t/settings');
  });
});
