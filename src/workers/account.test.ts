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
  notify_product_emails?: number;
  notify_marketing_emails?: number;
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
          notify_product_emails: 1,
          notify_marketing_emails: 1,
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
  } else if (sql.startsWith('UPDATE user SET notify_product_emails = ?')) {
    const u = store.users.get(bound[3] as string);
    if (u) {
      u.notify_product_emails = bound[0] as number;
      u.notify_marketing_emails = bound[1] as number;
    }
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
    async put(path: string, body?: unknown) {
      return app.fetch(
        new Request(`http://t${path}`, {
          method: 'PUT',
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

  it('updates notification preferences', async () => {
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    const res = await app.put('/api/account/notifications', {
      productEmails: false,
      marketingEmails: false,
    });
    expect(res.status).toBe(200);
    const u = store.users.get('u1');
    expect(u?.notify_product_emails).toBe(0);
    expect(u?.notify_marketing_emails).toBe(0);
  });

  it('rejects invalid notification payloads with 400', async () => {
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    const res = await app.put('/api/account/notifications', { productEmails: 'yes' });
    expect(res.status).toBe(400);
  });

  it('unauthenticated callers get 401', async () => {
    const store = makeStore();
    const app = userApp(store, null);
    expect((await app.post('/api/account/delete')).status).toBe(401);
    expect((await app.post('/api/account/delete/cancel')).status).toBe(401);
    expect((await app.get('/api/account')).status).toBe(401);
  });

  // The confirmation email body is a LEGAL-REVIEW placeholder. Until an email
  // provider lands, we just verify the trigger fires on /delete with the
  // correct user id + scheduled date so swapping the placeholder for a real
  // mailer is a one-line change.
  it('fires the confirmation-email trigger on delete', async () => {
    const store = makeStore();
    const app = userApp(store, { id: 'u1' });
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args);
    });
    await app.post('/api/account/delete');
    spy.mockRestore();

    const triggered = logs.find((args) => String(args[0]).includes('[account-delete]'));
    expect(triggered).toBeTruthy();
    const payload = triggered?.[1] as { userId: string; placeholder: boolean };
    expect(payload.userId).toBe('u1');
    expect(payload.placeholder).toBe(true);
  });
});
