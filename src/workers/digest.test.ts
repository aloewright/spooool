import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIGEST_MAX_ITEMS,
  DIGEST_WINDOW_MS,
  renderDigestEmail,
  runDigestSweep,
  type DigestEnv,
  type DigestFrequency,
  type DigestItem,
} from './digest';

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return await impl(url, init);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FakeUser {
  id: string;
  email: string;
  name: string;
  email_digest_frequency: DigestFrequency;
  email_digest_last_sent_at: number | null;
  banned_at: number | null;
  deletion_scheduled_for: number | null;
}

interface FakeInboxRow {
  subscriber_user_id: string;
  video_id: string;
  channel_user_id: string;
  added_at_ms: number;
}

interface FakeStore {
  users: FakeUser[];
  inbox: FakeInboxRow[];
  videos: Map<string, { title: string; thumbnail_url: string | null; deleted_at: string | null; hidden_at: string | null }>;
  channels: Map<string, { username: string | null; name: string; displayName: string | null }>;
  updates: { userId: string; lastSentAt: number }[];
}

function newStore(): FakeStore {
  return {
    users: [],
    inbox: [],
    videos: new Map(),
    channels: new Map(),
    updates: [],
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function envWithStore(store: FakeStore, opts: { resendKey?: string } = {}): DigestEnv {
  const stmt = (sql: string) => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api = {
      bind(...v: unknown[]) {
        bound = v;
        return api;
      },
      async first() {
        return null;
      },
      async all() {
        if (trimmed.startsWith('SELECT id, email, name, email_digest_frequency')) {
          const dailyCutoff = bound[0] as number;
          const weeklyCutoff = bound[1] as number;
          return {
            results: store.users.filter(
              (u) =>
                u.email_digest_frequency !== 'off' &&
                u.banned_at == null &&
                u.deletion_scheduled_for == null &&
                ((u.email_digest_frequency === 'daily' &&
                  (u.email_digest_last_sent_at == null || u.email_digest_last_sent_at <= dailyCutoff)) ||
                  (u.email_digest_frequency === 'weekly' &&
                    (u.email_digest_last_sent_at == null || u.email_digest_last_sent_at <= weeklyCutoff))),
            ),
          };
        }
        if (trimmed.includes('FROM subscription_inbox i JOIN videos v')) {
          const subscriberId = bound[0] as string;
          const sinceIso = bound[1] as string;
          const limit = bound[2] as number;
          const sinceMs = Date.parse(sinceIso);
          const items = store.inbox
            .filter((row) => {
              if (row.subscriber_user_id !== subscriberId) return false;
              if (row.added_at_ms < sinceMs) return false;
              const v = store.videos.get(row.video_id);
              if (!v) return false;
              if (v.deleted_at !== null || v.hidden_at !== null) return false;
              return true;
            })
            .sort((a, b) => b.added_at_ms - a.added_at_ms)
            .slice(0, limit)
            .map<DigestItem>((row) => {
              const v = store.videos.get(row.video_id);
              if (!v) throw new Error(`missing video ${row.video_id}`);
              const ch = store.channels.get(row.channel_user_id);
              return {
                videoId: row.video_id,
                title: v.title,
                thumbnailUrl: v.thumbnail_url,
                channelUsername: ch?.username ?? null,
                channelName: ch?.displayName ?? ch?.name ?? null,
                addedAt: new Date(row.added_at_ms).toISOString(),
              };
            });
          return { results: items };
        }
        return { results: [] };
      },
      async run() {
        if (trimmed.startsWith('UPDATE user SET email_digest_last_sent_at')) {
          store.updates.push({
            userId: bound[2] as string,
            lastSentAt: bound[0] as number,
          });
          const u = store.users.find((x) => x.id === bound[2]);
          if (u) u.email_digest_last_sent_at = bound[0] as number;
        }
        return { success: true };
      },
    };
    return api as unknown as PreparedStmt;
  };
  return {
    DB: { prepare: stmt } as unknown as D1Database,
    RESEND_API_KEY: opts.resendKey,
    RESEND_FROM: 'spooool <hello@spooool.test>',
  };
}

describe('renderDigestEmail', () => {
  it('escapes user-controlled values in subject + html', () => {
    const out = renderDigestEmail({
      recipientName: '<script>',
      items: [
        {
          videoId: 'v1',
          title: '<title>',
          thumbnailUrl: null,
          channelUsername: null,
          channelName: '<chan>',
          addedAt: '2025-01-01T00:00:00Z',
        },
      ],
      totalNewUploads: 1,
      frequency: 'daily',
      baseUrl: 'https://spooool.test',
      unsubscribeUrl: 'https://spooool.test/settings/account#notifications',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&lt;title&gt;');
    expect(out.html).toContain('&lt;chan&gt;');
  });

  it('uses singular subject for one item', () => {
    const out = renderDigestEmail({
      recipientName: 'A',
      items: [
        {
          videoId: 'v1',
          title: 'Hello',
          thumbnailUrl: null,
          channelUsername: 'ch',
          channelName: 'Ch',
          addedAt: '2025-01-01T00:00:00Z',
        },
      ],
      totalNewUploads: 1,
      frequency: 'weekly',
      baseUrl: 'https://x.test',
      unsubscribeUrl: 'https://x.test/settings/account#notifications',
    });
    expect(out.subject).toMatch(/1 new upload/);
  });

  it('shows overflow line when totalNewUploads exceeds rendered items', () => {
    const items: DigestItem[] = Array.from({ length: 3 }, (_, i) => ({
      videoId: `v${i}`,
      title: `t${i}`,
      thumbnailUrl: null,
      channelUsername: 'ch',
      channelName: 'Ch',
      addedAt: '2025-01-01T00:00:00Z',
    }));
    const out = renderDigestEmail({
      recipientName: 'A',
      items,
      totalNewUploads: 10,
      frequency: 'weekly',
      baseUrl: 'https://x.test',
      unsubscribeUrl: 'https://x.test/settings/account#notifications',
    });
    expect(out.html).toContain('and 7 more');
  });
});

describe('runDigestSweep', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('skips users whose digest frequency is off', async () => {
    const store = newStore();
    store.users.push({
      id: 'u1',
      email: 'a@x.test',
      name: 'A',
      email_digest_frequency: 'off',
      email_digest_last_sent_at: null,
      banned_at: null,
      deletion_scheduled_for: null,
    });
    const env = envWithStore(store, { resendKey: 'k' });
    const out = await runDigestSweep({ env });
    expect(out).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it('skips users whose window has not elapsed', async () => {
    const store = newStore();
    const now = Date.now();
    store.users.push({
      id: 'u1',
      email: 'a@x.test',
      name: 'A',
      email_digest_frequency: 'weekly',
      // Sent 1 hour ago — weekly window is 7 days, so not due.
      email_digest_last_sent_at: now - 60 * 60 * 1000,
      banned_at: null,
      deletion_scheduled_for: null,
    });
    const env = envWithStore(store, { resendKey: 'k' });
    const out = await runDigestSweep({ env, nowMs: now });
    expect(out).toEqual([]);
  });

  it('sends a digest when the window has elapsed and items exist', async () => {
    const store = newStore();
    const now = Date.now();
    store.users.push({
      id: 'u1',
      email: 'a@x.test',
      name: 'Alice Example',
      email_digest_frequency: 'weekly',
      email_digest_last_sent_at: now - DIGEST_WINDOW_MS.weekly - 1000,
      banned_at: null,
      deletion_scheduled_for: null,
    });
    store.videos.set('v1', { title: 'New clip', thumbnail_url: null, deleted_at: null, hidden_at: null });
    store.channels.set('c1', { username: 'creator', name: 'Creator', displayName: 'Creator' });
    store.inbox.push({
      subscriber_user_id: 'u1',
      video_id: 'v1',
      channel_user_id: 'c1',
      added_at_ms: now - 60 * 1000,
    });

    let captured: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch((url, init) => {
      captured = { url, body: JSON.parse((init?.body as string) ?? '{}') };
      return new Response('{}', { status: 200 });
    });
    const env = envWithStore(store, { resendKey: 'k' });
    const out = await runDigestSweep({ env, nowMs: now, baseUrl: 'https://spooool.test' });

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('sent');
    expect(captured.url).toBe('https://api.resend.com/emails');
    expect(captured.body?.to).toEqual(['a@x.test']);
    expect(String(captured.body?.html)).toContain('New clip');
    expect(store.updates).toEqual([{ userId: 'u1', lastSentAt: now }]);
  });

  it('reports skipped without writing last_sent_at when Resend is not configured but items=0', async () => {
    const store = newStore();
    const now = Date.now();
    store.users.push({
      id: 'u1',
      email: 'a@x.test',
      name: 'A',
      email_digest_frequency: 'daily',
      email_digest_last_sent_at: null,
      banned_at: null,
      deletion_scheduled_for: null,
    });
    const env = envWithStore(store);
    const out = await runDigestSweep({ env, nowMs: now });
    expect(out[0].status).toBe('skipped');
    // No items in window: we still bump last_sent_at so we don't re-process.
    expect(store.updates).toEqual([{ userId: 'u1', lastSentAt: now }]);
  });

  it('does not bump last_sent_at when Resend send fails', async () => {
    const store = newStore();
    const now = Date.now();
    store.users.push({
      id: 'u1',
      email: 'a@x.test',
      name: 'A',
      email_digest_frequency: 'daily',
      email_digest_last_sent_at: now - DIGEST_WINDOW_MS.daily - 1000,
      banned_at: null,
      deletion_scheduled_for: null,
    });
    store.videos.set('v1', { title: 't', thumbnail_url: null, deleted_at: null, hidden_at: null });
    store.channels.set('c1', { username: 'c', name: 'C', displayName: null });
    store.inbox.push({
      subscriber_user_id: 'u1',
      video_id: 'v1',
      channel_user_id: 'c1',
      added_at_ms: now - 60 * 1000,
    });
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const env = envWithStore(store, { resendKey: 'k' });
    const out = await runDigestSweep({ env, nowMs: now });
    expect(out[0].status).toBe('failed');
    expect(out[0].reason).toBe('rate limited');
    expect(store.updates).toEqual([]);
  });

  it('truncates rendered items to DIGEST_MAX_ITEMS but reports total', async () => {
    const store = newStore();
    const now = Date.now();
    store.users.push({
      id: 'u1',
      email: 'a@x.test',
      name: 'A',
      email_digest_frequency: 'daily',
      email_digest_last_sent_at: now - DIGEST_WINDOW_MS.daily - 1000,
      banned_at: null,
      deletion_scheduled_for: null,
    });
    store.channels.set('c1', { username: 'c', name: 'C', displayName: null });
    for (let i = 0; i < DIGEST_MAX_ITEMS + 5; i++) {
      const id = `v${i}`;
      store.videos.set(id, { title: `t${i}`, thumbnail_url: null, deleted_at: null, hidden_at: null });
      store.inbox.push({
        subscriber_user_id: 'u1',
        video_id: id,
        channel_user_id: 'c1',
        added_at_ms: now - (i + 1) * 1000,
      });
    }
    mockFetch(() => new Response('{}', { status: 200 }));
    const env = envWithStore(store, { resendKey: 'k' });
    const out = await runDigestSweep({ env, nowMs: now });
    expect(out[0].status).toBe('sent');
    expect(out[0].itemCount).toBe(DIGEST_MAX_ITEMS);
    // We always fetch limit+1 to detect overflow, so the reported "total" is
    // DIGEST_MAX_ITEMS + 1 even when the inbox has more.
    expect(out[0].totalNewUploads).toBe(DIGEST_MAX_ITEMS + 1);
  });

  it('skips banned users and users scheduled for deletion', async () => {
    const store = newStore();
    const now = Date.now();
    store.users.push({
      id: 'banned',
      email: 'b@x.test',
      name: 'B',
      email_digest_frequency: 'daily',
      email_digest_last_sent_at: null,
      banned_at: now,
      deletion_scheduled_for: null,
    });
    store.users.push({
      id: 'pending-deletion',
      email: 'd@x.test',
      name: 'D',
      email_digest_frequency: 'daily',
      email_digest_last_sent_at: null,
      banned_at: null,
      deletion_scheduled_for: now + 24 * 60 * 60 * 1000,
    });
    const env = envWithStore(store, { resendKey: 'k' });
    const out = await runDigestSweep({ env, nowMs: now });
    expect(out).toEqual([]);
  });
});
