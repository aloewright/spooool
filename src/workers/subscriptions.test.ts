import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscriptionRoutes, type SubscriptionsEnv } from './subscriptions';

interface UserRow {
  id: string;
  username: string;
}

interface SubRow {
  id: string;
  subscriber_user_id: string;
  channel_user_id: string;
  created_at: string;
}

interface InboxRow {
  subscriber_user_id: string;
  video_id: string;
  channel_user_id: string;
  added_at: string;
  seen_at: string | null;
  digest_sent_at: string | null;
  // joined for queries
  video_title?: string;
  video_thumbnail_url?: string | null;
  video_created_at?: string;
  channel_name?: string | null;
  channel_username?: string | null;
  user_email?: string;
  user_name?: string | null;
}

interface VideoRow {
  id: string;
  title: string;
  thumbnail_url: string | null;
  created_at: string;
  deleted_at: string | null;
  hidden_at: string | null;
}

interface AdminRoleRow {
  user_id: string;
  role: string;
}

interface Store {
  users: UserRow[];
  videos: VideoRow[];
  subs: SubRow[];
  inbox: InboxRow[];
  roles: AdminRoleRow[];
  emails: Map<string, string>;
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function fakeDB(store: Store): D1Database {
  function prepare(sql: string): PreparedStmt {
    const flat = sql.replace(/\s+/g, ' ').trim();
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values: unknown[]) {
        args = values;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (flat.startsWith('SELECT id FROM user WHERE username = ?')) {
          const [username] = args as [string];
          const u = store.users.find((x) => x.username === username);
          return (u ? ({ id: u.id } as unknown as T) : null);
        }
        if (flat.startsWith('SELECT COUNT(*) AS c FROM subscriptions')) {
          const [channelId] = args as [string];
          const c = store.subs.filter((s) => s.channel_user_id === channelId).length;
          return ({ c } as unknown as T);
        }
        if (flat.startsWith('SELECT 1 FROM subscriptions WHERE subscriber_user_id = ?')) {
          const [subId, channelId] = args as [string, string];
          const found = store.subs.find(
            (s) => s.subscriber_user_id === subId && s.channel_user_id === channelId,
          );
          return (found ? ({ '1': 1 } as unknown as T) : null);
        }
        if (flat.startsWith('SELECT COUNT(*) AS c FROM subscription_inbox i')) {
          const [subId] = args as [string];
          const c = store.inbox
            .filter((r) => r.subscriber_user_id === subId && r.seen_at === null)
            .filter((r) => {
              const v = store.videos.find((vv) => vv.id === r.video_id);
              return v != null && v.deleted_at === null && v.hidden_at === null;
            }).length;
          return ({ c } as unknown as T);
        }
        if (flat.startsWith('SELECT 1 FROM user_roles WHERE user_id = ?')) {
          const [userId, role] = args as [string, string];
          const found = store.roles.find((r) => r.user_id === userId && r.role === role);
          return (found ? ({ '1': 1 } as unknown as T) : null);
        }
        if (flat.startsWith("SELECT 1 FROM user_roles WHERE role = 'admin'")) {
          const found = store.roles.some((r) => r.role === 'admin');
          return (found ? ({ '1': 1 } as unknown as T) : null);
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (flat.startsWith('SELECT u.id, u.username, u.displayName, u.name, u.avatarUrl')) {
          const [subscriberId] = args as [string];
          const rows = store.subs
            .filter((s) => s.subscriber_user_id === subscriberId)
            .map((s) => {
              const u = store.users.find((x) => x.id === s.channel_user_id);
              return { id: u?.id, username: u?.username, subscribed_at: s.created_at };
            });
          return { results: rows as unknown as T[] };
        }
        if (flat.startsWith('SELECT i.video_id, i.channel_user_id, i.added_at, i.seen_at')) {
          const [subscriberId, unseenFlag, limit, offset] = args as [
            string,
            number,
            number,
            number,
          ];
          let rows = store.inbox.filter((i) => i.subscriber_user_id === subscriberId);
          rows = rows.filter((r) => {
            const v = store.videos.find((vv) => vv.id === r.video_id);
            return v != null && v.deleted_at === null;
          });
          if (unseenFlag === 1) {
            rows = rows.filter((r) => r.seen_at === null);
          }
          rows.sort((a, b) => b.added_at.localeCompare(a.added_at));
          const sliced = rows.slice(offset, offset + limit).map((r) => {
            const v = store.videos.find((vv) => vv.id === r.video_id);
            const ch = store.users.find((u) => u.id === r.channel_user_id);
            return {
              video_id: r.video_id,
              channel_user_id: r.channel_user_id,
              added_at: r.added_at,
              seen_at: r.seen_at,
              title: v?.title ?? null,
              thumbnail_url: v?.thumbnail_url ?? null,
              video_created_at: v?.created_at ?? null,
              channel_name: ch?.username ?? null,
              channel_username: ch?.username ?? null,
            };
          });
          return { results: sliced as unknown as T[] };
        }
        if (flat.startsWith('SELECT i.subscriber_user_id, u.email AS user_email')) {
          const rows = store.inbox
            .filter((r) => r.seen_at === null && r.digest_sent_at === null)
            .map((r) => {
              const v = store.videos.find((vv) => vv.id === r.video_id);
              const ch = store.users.find((u) => u.id === r.channel_user_id);
              const email = store.emails.get(r.subscriber_user_id);
              return {
                subscriber_user_id: r.subscriber_user_id,
                user_email: email ?? '',
                user_name: null,
                video_id: r.video_id,
                title: v?.title ?? '',
                thumbnail_url: v?.thumbnail_url ?? null,
                channel_name: ch?.username ?? null,
                channel_username: ch?.username ?? null,
                added_at: r.added_at,
              };
            });
          return { results: rows as unknown as T[] };
        }
        return { results: [] };
      },
      async run(): Promise<{ success: boolean }> {
        if (flat.startsWith('INSERT INTO subscriptions')) {
          const [id, subId, channelId] = args as [string, string, string];
          const exists = store.subs.find(
            (s) => s.subscriber_user_id === subId && s.channel_user_id === channelId,
          );
          if (!exists) {
            store.subs.push({
              id,
              subscriber_user_id: subId,
              channel_user_id: channelId,
              created_at: '2026-05-01T00:00:00Z',
            });
          }
          return { success: true };
        }
        if (flat.startsWith('DELETE FROM subscriptions')) {
          const [subId, channelId] = args as [string, string];
          store.subs = store.subs.filter(
            (s) => !(s.subscriber_user_id === subId && s.channel_user_id === channelId),
          );
          return { success: true };
        }
        if (flat.startsWith('UPDATE subscription_inbox SET seen_at = CURRENT_TIMESTAMP')) {
          const [subId] = args as [string];
          for (const r of store.inbox) {
            if (r.subscriber_user_id === subId && r.seen_at === null) {
              r.seen_at = '2026-05-01T00:00:00Z';
            }
          }
          return { success: true };
        }
        if (flat.startsWith('UPDATE subscription_inbox SET digest_sent_at = ?')) {
          const [now, subId, ...videoIds] = args as [string, string, ...string[]];
          for (const r of store.inbox) {
            if (
              r.subscriber_user_id === subId &&
              videoIds.includes(r.video_id) &&
              r.seen_at === null
            ) {
              r.digest_sent_at = now;
            }
          }
          return { success: true };
        }
        return { success: true };
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

type SessionUser = { id: string; email: string; name: string } | null;

function buildApp(
  store: Store,
  user: SessionUser,
): {
  app: Hono<{ Bindings: SubscriptionsEnv; Variables: { user: SessionUser } }>;
  env: SubscriptionsEnv;
} {
  const env: SubscriptionsEnv = {
    DB: fakeDB(store),
    ADMIN_EMAILS: 'admin@example.com',
  };
  const app = new Hono<{ Bindings: SubscriptionsEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', subscriptionRoutes);
  return { app, env };
}

function makeStore(): Store {
  return {
    users: [
      { id: 'creator-1', username: 'creator' },
      { id: 'viewer-1', username: 'viewer' },
    ],
    videos: [
      {
        id: 'v1',
        title: 'A',
        thumbnail_url: 'https://thumbs/a.jpg',
        created_at: '2026-05-01',
        deleted_at: null,
        hidden_at: null,
      },
      {
        id: 'v2',
        title: 'B',
        thumbnail_url: null,
        created_at: '2026-05-02',
        deleted_at: null,
        hidden_at: null,
      },
    ],
    subs: [],
    inbox: [],
    roles: [],
    emails: new Map([['viewer-1', 'viewer@example.com']]),
  };
}

describe('GET /api/users/me/inbox/unseen-count', () => {
  it('returns 401 when not signed in', async () => {
    const { app, env } = buildApp(makeStore(), null);
    const res = await app.request('/api/users/me/inbox/unseen-count', {}, env);
    expect(res.status).toBe(401);
  });

  it('returns the count of unseen rows for the authenticated user', async () => {
    const store = makeStore();
    store.inbox.push(
      {
        subscriber_user_id: 'viewer-1',
        video_id: 'v1',
        channel_user_id: 'creator-1',
        added_at: '2026-05-01',
        seen_at: null,
        digest_sent_at: null,
      },
      {
        subscriber_user_id: 'viewer-1',
        video_id: 'v2',
        channel_user_id: 'creator-1',
        added_at: '2026-05-02',
        seen_at: '2026-05-02',
        digest_sent_at: null,
      },
    );
    const { app, env } = buildApp(store, {
      id: 'viewer-1',
      email: 'viewer@example.com',
      name: 'V',
    });
    const res = await app.request('/api/users/me/inbox/unseen-count', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unseen: number };
    expect(body.unseen).toBe(1);
  });

  it('hides counts of soft-deleted videos', async () => {
    const store = makeStore();
    store.videos[0].deleted_at = '2026-05-02';
    store.inbox.push({
      subscriber_user_id: 'viewer-1',
      video_id: 'v1',
      channel_user_id: 'creator-1',
      added_at: '2026-05-01',
      seen_at: null,
      digest_sent_at: null,
    });
    const { app, env } = buildApp(store, {
      id: 'viewer-1',
      email: 'viewer@example.com',
      name: 'V',
    });
    const res = await app.request('/api/users/me/inbox/unseen-count', {}, env);
    const body = (await res.json()) as { unseen: number };
    expect(body.unseen).toBe(0);
  });
});

describe('POST /api/admin/inbox/digest/run', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  it('rejects non-admin callers with 403', async () => {
    const store = makeStore();
    const { app, env } = buildApp(store, {
      id: 'viewer-1',
      email: 'viewer@example.com',
      name: 'V',
    });
    const res = await app.request(
      '/api/admin/inbox/digest/run',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(403);
    fetchMock.mockRestore();
  });

  it('runs the digest sweep for admin callers and reports stats', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const store = makeStore();
    store.inbox.push({
      subscriber_user_id: 'viewer-1',
      video_id: 'v1',
      channel_user_id: 'creator-1',
      added_at: '2026-05-01',
      seen_at: null,
      digest_sent_at: null,
    });
    const { app, env } = buildApp(store, {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'A',
    });
    env.RESEND_API_KEY = 'rs_test';
    const res = await app.request(
      '/api/admin/inbox/digest/run',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stats: { recipients: number; sent: number; failed: number; skipped: number };
    };
    expect(body.ok).toBe(true);
    expect(body.stats.recipients).toBe(1);
    expect(body.stats.sent).toBe(1);
    fetchMock.mockRestore();
  });
});
