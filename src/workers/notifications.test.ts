import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  DIGEST_FREQUENCIES,
  UNREAD_BADGE_CAP,
  notificationRoutes,
  type NotificationsEnv,
} from './notifications';

interface FakeUserRow {
  id: string;
  email: string;
  name: string;
  email_digest_frequency: 'off' | 'daily' | 'weekly';
  email_digest_last_sent_at: number | null;
}

interface FakeStore {
  users: Map<string, FakeUserRow>;
  inbox: { subscriber_user_id: string; seen_at: string | null }[];
}

function makeStore(): FakeStore {
  return {
    users: new Map([
      [
        'u1',
        {
          id: 'u1',
          email: 'a@b.test',
          name: 'Alice',
          email_digest_frequency: 'weekly',
          email_digest_last_sent_at: null,
        },
      ],
    ]),
    inbox: [
      { subscriber_user_id: 'u1', seen_at: null },
      { subscriber_user_id: 'u1', seen_at: null },
      { subscriber_user_id: 'u1', seen_at: '2025-05-01T00:00:00Z' },
      { subscriber_user_id: 'u2', seen_at: null },
    ],
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function envWithStore(store: FakeStore): NotificationsEnv {
  const stmt = (sql: string) => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api = {
      bind(...v: unknown[]) {
        bound = v;
        return api;
      },
      async first() {
        if (trimmed.includes('FROM subscription_inbox WHERE subscriber_user_id = ? AND seen_at IS NULL')) {
          const limit = bound[1] as number;
          const matches = store.inbox.filter(
            (i) => i.subscriber_user_id === bound[0] && i.seen_at === null,
          ).length;
          return { c: Math.min(matches, limit) };
        }
        if (trimmed.startsWith('SELECT email_digest_frequency')) {
          const u = store.users.get(bound[0] as string);
          return u
            ? {
                email_digest_frequency: u.email_digest_frequency,
                email_digest_last_sent_at: u.email_digest_last_sent_at,
              }
            : null;
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (trimmed.startsWith('UPDATE user SET email_digest_frequency = ?')) {
          const u = store.users.get(bound[2] as string);
          if (u) u.email_digest_frequency = bound[0] as 'off' | 'daily' | 'weekly';
        }
        return { success: true };
      },
    };
    return api as unknown as PreparedStmt;
  };
  return {
    DB: { prepare: stmt } as unknown as D1Database,
  };
}

type AppCtx = {
  Variables: { user: { id: string } | null };
};

function makeApp(store: FakeStore, asUser: { id: string } | null) {
  const app = new Hono<AppCtx>();
  app.use('*', async (c, next) => {
    c.set('user', asUser);
    await next();
  });
  app.route('/', notificationRoutes);
  return {
    fetch: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://t${path}`, init), envWithStore(store) as never),
  };
}

describe('GET /api/users/me/notifications/unread-count', () => {
  it('returns the count of unseen inbox rows for the current user', async () => {
    const store = makeStore();
    const app = makeApp(store, { id: 'u1' });
    const res = await app.fetch('/api/users/me/notifications/unread-count');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { unread: number; capped: boolean };
    expect(data.unread).toBe(2);
    expect(data.capped).toBe(false);
  });

  it('reports capped=true when unread exceeds the badge cap', async () => {
    const store = makeStore();
    store.inbox = Array.from({ length: UNREAD_BADGE_CAP + 5 }, () => ({
      subscriber_user_id: 'u1',
      seen_at: null,
    }));
    const app = makeApp(store, { id: 'u1' });
    const res = await app.fetch('/api/users/me/notifications/unread-count');
    const data = (await res.json()) as { unread: number; capped: boolean };
    // The endpoint LIMITs to UNREAD_BADGE_CAP+1 so we can detect overflow
    // without scanning the whole table.
    expect(data.unread).toBe(UNREAD_BADGE_CAP + 1);
    expect(data.capped).toBe(true);
  });

  it('returns 401 when unauthenticated', async () => {
    const store = makeStore();
    const app = makeApp(store, null);
    const res = await app.fetch('/api/users/me/notifications/unread-count');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/me/notifications/preferences', () => {
  it('returns the current digest frequency + last sent', async () => {
    const store = makeStore();
    const u = store.users.get('u1');
    if (u) u.email_digest_last_sent_at = 1700000000000;
    const app = makeApp(store, { id: 'u1' });
    const res = await app.fetch('/api/users/me/notifications/preferences');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      emailDigestFrequency: string;
      emailDigestLastSentAt: number | null;
    };
    expect(data.emailDigestFrequency).toBe('weekly');
    expect(data.emailDigestLastSentAt).toBe(1700000000000);
  });

  it('returns 401 when unauthenticated', async () => {
    const store = makeStore();
    const app = makeApp(store, null);
    const res = await app.fetch('/api/users/me/notifications/preferences');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/users/me/notifications/preferences', () => {
  it('persists a valid frequency', async () => {
    const store = makeStore();
    const app = makeApp(store, { id: 'u1' });
    const res = await app.fetch('/api/users/me/notifications/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailDigestFrequency: 'daily' }),
    });
    expect(res.status).toBe(200);
    expect(store.users.get('u1')?.email_digest_frequency).toBe('daily');
  });

  it('rejects unknown frequencies with 400', async () => {
    const store = makeStore();
    const app = makeApp(store, { id: 'u1' });
    const res = await app.fetch('/api/users/me/notifications/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailDigestFrequency: 'never' }),
    });
    expect(res.status).toBe(400);
    expect(store.users.get('u1')?.email_digest_frequency).toBe('weekly');
  });

  it('returns 401 when unauthenticated', async () => {
    const store = makeStore();
    const app = makeApp(store, null);
    const res = await app.fetch('/api/users/me/notifications/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailDigestFrequency: 'off' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('digest frequencies enum', () => {
  it('exposes off / daily / weekly', () => {
    expect([...DIGEST_FREQUENCIES].sort()).toEqual(['daily', 'off', 'weekly']);
  });
});
