import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { subscriptionRoutes, type SubscriptionsEnv } from './subscriptions';

type SessionUser = { id: string } | null;

interface FakeStmt {
  bind: (...values: unknown[]) => FakeStmt;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean; meta?: { changes: number } }>;
}

interface FakeDBSpec {
  // username → channel row for the SELECT id lookup.
  channels?: Record<string, { id: string }>;
  // initial subscription tuples (subscriber_user_id, channel_user_id).
  subscriptions?: Set<string>;
  subscriberCount?: number;
  // rows the GET /me/subscriptions and /me/inbox queries should return.
  meSubscriptions?: unknown[];
  inboxItems?: unknown[];
  inboxCount?: number;
  runs?: Array<{ sql: string; bound: unknown[] }>;
}

function subscriptionKey(subscriber: string, channel: string): string {
  return `${subscriber}|${channel}`;
}

// Whitespace-insensitive — the formatter elsewhere can re-wrap the SQL
// without breaking this test fixture.
const ME_SUBSCRIPTIONS_JOIN_RE = /FROM\s+subscriptions\s+s\s+JOIN\s+user\s+u/i;

function fakeDB(spec: FakeDBSpec): D1Database {
  const subscriptions = spec.subscriptions ?? new Set<string>();
  const runs = spec.runs ?? [];
  spec.subscriptions = subscriptions;
  spec.runs = runs;
  const prepare = (sql: string): FakeStmt => {
    let bound: unknown[] = [];
    const stmt: FakeStmt = {
      bind: (...values) => {
        bound = values;
        return stmt;
      },
      first: async () => {
        if (sql.startsWith('SELECT id FROM user')) {
          const username = bound[0] as string;
          return (spec.channels?.[username] ?? null) as never;
        }
        if (sql.includes('FROM subscription_inbox') && sql.includes('COUNT(*)')) {
          return { count: spec.inboxCount ?? 0 } as never;
        }
        if (sql.startsWith('SELECT COUNT(*)')) {
          return { c: spec.subscriberCount ?? subscriptions.size } as never;
        }
        if (sql.startsWith('SELECT 1 FROM subscriptions')) {
          const [sub, ch] = bound as [string, string];
          return (subscriptions.has(subscriptionKey(sub, ch)) ? { '1': 1 } : null) as never;
        }
        return null;
      },
      all: async () => {
        if (ME_SUBSCRIPTIONS_JOIN_RE.test(sql)) {
          return { results: (spec.meSubscriptions ?? []) as never[] };
        }
        if (sql.includes('FROM subscription_inbox')) {
          return { results: (spec.inboxItems ?? []) as never[] };
        }
        return { results: [] as never[] };
      },
      run: async () => {
        runs.push({ sql, bound: [...bound] });
        if (sql.startsWith('INSERT INTO subscriptions')) {
          const [, subscriber, channel] = bound as [string, string, string];
          subscriptions.add(subscriptionKey(subscriber, channel));
        } else if (sql.startsWith('DELETE FROM subscriptions')) {
          const [subscriber, channel] = bound as [string, string];
          subscriptions.delete(subscriptionKey(subscriber, channel));
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

function buildApp(db: D1Database, user: SessionUser) {
  const app = new Hono<{ Bindings: SubscriptionsEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', subscriptionRoutes);
  return (path: string, init?: RequestInit) => app.request(path, init, { DB: db });
}

describe('GET /api/channels/:username/subscription', () => {
  it('returns 404 when the channel does not exist', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/channels/ghost/subscription');
    expect(res.status).toBe(404);
  });

  it('returns subscribed=false and the public count for anon viewers', async () => {
    const req = buildApp(
      fakeDB({ channels: { alice: { id: 'u1' } }, subscriberCount: 7 }),
      null,
    );
    const res = await req('/api/channels/alice/subscription');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscribed: boolean; subscriberCount: number };
    expect(body).toEqual({ subscribed: false, subscriberCount: 7 });
  });

  it('reflects an existing subscription for the signed-in viewer', async () => {
    const subs = new Set([subscriptionKey('me', 'u1')]);
    const req = buildApp(
      fakeDB({ channels: { alice: { id: 'u1' } }, subscriptions: subs, subscriberCount: 3 }),
      { id: 'me' },
    );
    const res = await req('/api/channels/alice/subscription');
    const body = (await res.json()) as { subscribed: boolean };
    expect(body.subscribed).toBe(true);
  });
});

describe('POST /api/channels/:username/subscribe', () => {
  it('401s for anon', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/channels/alice/subscribe', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses to subscribe to your own channel', async () => {
    const req = buildApp(
      fakeDB({ channels: { me: { id: 'me' } } }),
      { id: 'me' },
    );
    const res = await req('/api/channels/me/subscribe', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('inserts a row and reports subscribed=true', async () => {
    const subscriptions = new Set<string>();
    const req = buildApp(
      fakeDB({ channels: { alice: { id: 'u1' } }, subscriptions }),
      { id: 'me' },
    );
    const res = await req('/api/channels/alice/subscribe', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: true });
    expect(subscriptions.has(subscriptionKey('me', 'u1'))).toBe(true);
  });
});

describe('DELETE /api/channels/:username/subscribe', () => {
  it('401s for anon', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/channels/alice/subscribe', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('removes the row and reports subscribed=false', async () => {
    const subscriptions = new Set([subscriptionKey('me', 'u1')]);
    const req = buildApp(
      fakeDB({ channels: { alice: { id: 'u1' } }, subscriptions }),
      { id: 'me' },
    );
    const res = await req('/api/channels/alice/subscribe', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
    expect(subscriptions.has(subscriptionKey('me', 'u1'))).toBe(false);
  });
});

describe('GET /api/users/me/subscriptions', () => {
  it('401s for anon', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/users/me/subscriptions');
    expect(res.status).toBe(401);
  });

  it('returns the joined subscription rows', async () => {
    const rows = [{ id: 'u1', username: 'alice', displayName: null, name: 'Alice', avatarUrl: null, subscribed_at: '2025-01-01' }];
    const req = buildApp(fakeDB({ meSubscriptions: rows }), { id: 'me' });
    const res = await req('/api/users/me/subscriptions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscriptions: rows });
  });
});

describe('GET /api/users/me/inbox/unread-count', () => {
  it('returns 401 when unauthenticated', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/users/me/inbox/unread-count');
    expect(res.status).toBe(401);
  });

  it('returns unseen inbox count for the current user', async () => {
    const req = buildApp(
      fakeDB({
        inboxCount: 3,
      }),
      { id: 'me' },
    );
    const res = await req('/api/users/me/inbox/unread-count');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });
});

describe('GET /api/users/me/inbox', () => {
  it('401s for anon', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/users/me/inbox');
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid limit', async () => {
    const req = buildApp(fakeDB({}), { id: 'me' });
    const res = await req('/api/users/me/inbox?limit=-1');
    expect(res.status).toBe(400);
  });

  it('echoes unseenOnly flag and forwards items', async () => {
    const items = [{ video_id: 'v1', channel_user_id: 'u1', added_at: 't', seen_at: null }];
    const req = buildApp(fakeDB({ inboxItems: items }), { id: 'me' });
    const res = await req('/api/users/me/inbox?unseenOnly=1');
    const body = (await res.json()) as { items: unknown[]; unseenOnly: boolean };
    expect(body.unseenOnly).toBe(true);
    expect(body.items).toEqual(items);
  });
});

describe('POST /api/users/me/inbox/seen', () => {
  it('401s for anon', async () => {
    const req = buildApp(fakeDB({}), null);
    const res = await req('/api/users/me/inbox/seen', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('runs the UPDATE for the signed-in user', async () => {
    const spec: FakeDBSpec = {};
    const req = buildApp(fakeDB(spec), { id: 'me' });
    const res = await req('/api/users/me/inbox/seen', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(spec.runs?.[0]?.sql).toContain('UPDATE subscription_inbox');
    expect(spec.runs?.[0]?.bound).toEqual(['me']);
  });
});
