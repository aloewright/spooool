import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  groupItemsByRecipient,
  renderInboxDigestEmail,
  runInboxDigestSweep,
  type InboxDigestEnv,
} from './inbox-digest';

interface InboxRow {
  subscriber_user_id: string;
  user_email: string;
  user_name: string | null;
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  channel_username: string | null;
  added_at: string;
  seen_at: string | null;
  digest_sent_at: string | null;
}

interface Store {
  rows: InboxRow[];
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
        return null as unknown as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (flat.startsWith('SELECT i.subscriber_user_id, u.email AS user_email')) {
          const filtered = store.rows
            .filter((r) => r.seen_at === null && r.digest_sent_at === null)
            .sort((a, b) => {
              if (a.subscriber_user_id !== b.subscriber_user_id) {
                return a.subscriber_user_id.localeCompare(b.subscriber_user_id);
              }
              return b.added_at.localeCompare(a.added_at);
            });
          return { results: filtered as unknown as T[] };
        }
        return { results: [] };
      },
      async run(): Promise<{ success: boolean }> {
        if (flat.startsWith('UPDATE subscription_inbox SET digest_sent_at = ?')) {
          const [now, subscriberId, ...videoIds] = args as [string, string, ...string[]];
          for (const r of store.rows) {
            if (r.subscriber_user_id === subscriberId && videoIds.includes(r.video_id) && r.seen_at === null) {
              r.digest_sent_at = now;
            }
          }
        }
        return { success: true };
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

describe('groupItemsByRecipient', () => {
  it('groups rows by subscriber_user_id and preserves order', () => {
    const rows = [
      mkRow({ subscriber_user_id: 'a', video_id: 'v1', added_at: '2026-05-01' }),
      mkRow({ subscriber_user_id: 'a', video_id: 'v2', added_at: '2026-05-02' }),
      mkRow({ subscriber_user_id: 'b', video_id: 'v3', added_at: '2026-05-03' }),
    ];
    const groups = groupItemsByRecipient(rows);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.userId === 'a');
    expect(a?.items.map((i) => i.videoId)).toEqual(['v1', 'v2']);
    const b = groups.find((g) => g.userId === 'b');
    expect(b?.items.map((i) => i.videoId)).toEqual(['v3']);
  });

  it('drops rows with no email so we never call Resend with an empty to', () => {
    const rows = [
      mkRow({ subscriber_user_id: 'a', user_email: '', video_id: 'v1', added_at: '2026-05-01' }),
    ];
    expect(groupItemsByRecipient(rows)).toEqual([]);
  });

  it('caps items per recipient at 25', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      mkRow({ subscriber_user_id: 'a', video_id: `v${i}`, added_at: `2026-05-${String(i).padStart(2, '0')}` }),
    );
    const groups = groupItemsByRecipient(rows);
    expect(groups[0].items).toHaveLength(25);
  });
});

describe('renderInboxDigestEmail', () => {
  it('produces a singular subject for one item', () => {
    const out = renderInboxDigestEmail({
      origin: 'https://spooool.com',
      recipient: {
        userId: 'a',
        email: 'a@example.com',
        name: 'Alice Doe',
        items: [
          {
            videoId: 'v1',
            title: 'My clip',
            thumbnailUrl: null,
            channelName: 'Bob',
            channelUsername: 'bob',
            addedAt: '2026-05-01',
          },
        ],
      },
    });
    expect(out.subject).toBe('New on spooool: My clip');
    expect(out.html).toContain('Hi Alice');
    expect(out.html).toContain('https://spooool.com/watch/v1');
    expect(out.html).toContain('https://spooool.com/channel/bob');
    expect(out.html).toContain('https://spooool.com/inbox');
  });

  it('produces a plural subject for multiple items', () => {
    const out = renderInboxDigestEmail({
      origin: 'https://x.test',
      recipient: {
        userId: 'a',
        email: 'a@example.com',
        name: null,
        items: [
          {
            videoId: 'v1',
            title: 't1',
            thumbnailUrl: null,
            channelName: 'C',
            channelUsername: null,
            addedAt: '2026-05-01',
          },
          {
            videoId: 'v2',
            title: 't2',
            thumbnailUrl: 'https://thumbs/2.jpg',
            channelName: 'C2',
            channelUsername: null,
            addedAt: '2026-05-02',
          },
        ],
      },
    });
    expect(out.subject).toBe('2 new videos from creators you follow on spooool');
    expect(out.html).toContain('Hi,');
    expect(out.html).toContain('https://thumbs/2.jpg');
  });

  it('escapes hostile titles + names', () => {
    const out = renderInboxDigestEmail({
      origin: 'https://x.test',
      recipient: {
        userId: 'a',
        email: 'a@example.com',
        name: 'A & B',
        items: [
          {
            videoId: 'v1',
            title: '<script>x</script>',
            thumbnailUrl: null,
            channelName: 'A & B',
            channelUsername: null,
            addedAt: '2026-05-01',
          },
        ],
      },
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('A &amp; B');
  });
});

describe('runInboxDigestSweep', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('returns zeroes and skips when RESEND_API_KEY is missing', async () => {
    const store: Store = {
      rows: [mkRow({ subscriber_user_id: 'a', video_id: 'v1', added_at: '2026-05-01' })],
    };
    const env: InboxDigestEnv = {
      DB: fakeDB(store),
    };
    const stats = await runInboxDigestSweep(env);
    expect(stats).toEqual({ recipients: 0, sent: 0, skipped: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one email per recipient and stamps digest_sent_at', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const store: Store = {
      rows: [
        mkRow({ subscriber_user_id: 'a', video_id: 'v1', added_at: '2026-05-01' }),
        mkRow({ subscriber_user_id: 'a', video_id: 'v2', added_at: '2026-05-02' }),
        mkRow({ subscriber_user_id: 'b', video_id: 'v3', added_at: '2026-05-03', user_email: 'b@example.com' }),
      ],
    };
    const env: InboxDigestEnv = {
      DB: fakeDB(store),
      RESEND_API_KEY: 'rs_test',
    };
    const stats = await runInboxDigestSweep(env);
    expect(stats.recipients).toBe(2);
    expect(stats.sent).toBe(2);
    expect(stats.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const row of store.rows) {
      expect(row.digest_sent_at).not.toBeNull();
    }
  });

  it('skips already-digested or seen rows on re-run', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const store: Store = {
      rows: [
        mkRow({
          subscriber_user_id: 'a',
          video_id: 'v1',
          added_at: '2026-05-01',
          digest_sent_at: '2026-05-01',
        }),
        mkRow({
          subscriber_user_id: 'a',
          video_id: 'v2',
          added_at: '2026-05-02',
          seen_at: '2026-05-02',
        }),
      ],
    };
    const env: InboxDigestEnv = {
      DB: fakeDB(store),
      RESEND_API_KEY: 'rs_test',
    };
    const stats = await runInboxDigestSweep(env);
    expect(stats.recipients).toBe(0);
    expect(stats.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts a failure when Resend returns 5xx and does not stamp the row', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"boom"}', { status: 500 }));
    const store: Store = {
      rows: [mkRow({ subscriber_user_id: 'a', video_id: 'v1', added_at: '2026-05-01' })],
    };
    const env: InboxDigestEnv = {
      DB: fakeDB(store),
      RESEND_API_KEY: 'rs_test',
    };
    const stats = await runInboxDigestSweep(env);
    expect(stats.recipients).toBe(1);
    expect(stats.sent).toBe(0);
    expect(stats.failed).toBe(1);
    expect(store.rows[0].digest_sent_at).toBeNull();
  });
});

function mkRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    subscriber_user_id: 'a',
    user_email: 'a@example.com',
    user_name: 'Alice',
    video_id: 'v1',
    title: 'My clip',
    thumbnail_url: null,
    channel_name: 'Bob',
    channel_username: 'bob',
    added_at: '2026-05-01',
    seen_at: null,
    digest_sent_at: null,
    ...overrides,
  };
}
