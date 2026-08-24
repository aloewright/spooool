import { describe, expect, it } from 'vitest';
import { ChannelSubscriberDO, triggerFanOut } from './channel-do';

// ---------------------------------------------------------------------------
// Fake DurableObjectState — only blockConcurrencyWhile is needed by fanOut.
// ---------------------------------------------------------------------------
function fakeState(): DurableObjectState {
  return {
    blockConcurrencyWhile<T>(cb: () => Promise<T>): Promise<T> {
      return cb();
    },
  } as unknown as DurableObjectState;
}

// ---------------------------------------------------------------------------
// Fake D1Database
//
// The fanOut loop:
//   1. SELECT subscriber_user_id FROM subscriptions WHERE channel_user_id = ?
//      AND subscriber_user_id > ?  ORDER BY subscriber_user_id ASC  LIMIT ?
//   2. DB.batch([INSERT INTO subscription_inbox ... ON CONFLICT DO NOTHING])
//
// The fake pages subscribers by cursor and records every batch INSERT.
// ---------------------------------------------------------------------------
type InsertTuple = [subscriberId: string, videoId: string, channelUserId: string];

interface FakeStmt {
  bind: (...values: unknown[]) => FakeStmt;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean }>;
  _sql: string;
  _bound: unknown[];
}

function fakeDB(opts: { subscribers?: string[] } = {}): {
  db: D1Database;
  inserts: InsertTuple[];
} {
  const subscribers = (opts.subscribers ?? []).slice().sort();
  const inserts: InsertTuple[] = [];

  // Each bind() call must return a NEW stmt with the new bound values so that
  // `rows.map((r) => stmt.bind(r.id, videoId, channelId))` produces N distinct
  // objects, not N references to the same mutated object.
  const makeFakeStmt = (sql: string, bound: unknown[] = []): FakeStmt => {
    const stmt: FakeStmt = {
      _sql: sql,
      _bound: bound,
      bind: (...values: unknown[]) => makeFakeStmt(sql, values),
      first: async <T>() => null as T | null,
      all: async <T>() => {
        // Subscription page query: (channelUserId, cursor, limit)
        if (sql.includes('FROM subscriptions') && sql.includes('subscriber_user_id > ?')) {
          const cursor = bound[1] as string;
          const limit = bound[2] as number;
          const page = subscribers.filter((id) => id > cursor).slice(0, limit);
          return { results: page.map((id) => ({ subscriber_user_id: id })) as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => ({ success: true }),
    };
    return stmt;
  };

  const db: D1Database = {
    prepare: (sql: string) => makeFakeStmt(sql) as unknown as D1PreparedStatement,
    batch: async (stmts: D1PreparedStatement[]) => {
      for (const s of stmts) {
        const fake = s as unknown as FakeStmt;
        if (fake._sql?.includes('INSERT INTO subscription_inbox')) {
          inserts.push(fake._bound as InsertTuple);
        }
      }
      return stmts.map(() => ({
        results: [],
        success: true,
        meta: { duration: 0, last_row_id: 0, changes: 1, size_after: 0, rows_read: 0, rows_written: 0, changed_db: false },
      }));
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;

  return { db, inserts };
}

function makeDO(subscribers: string[] = []): {
  do: ChannelSubscriberDO;
  inserts: InsertTuple[];
} {
  const { db, inserts } = fakeDB({ subscribers });
  const doInstance = new ChannelSubscriberDO(fakeState(), { DB: db });
  return { do: doInstance, inserts };
}

async function fanOutRequest(
  doInstance: ChannelSubscriberDO,
  videoId: string,
  channelUserId: string,
): Promise<{ inserted: number }> {
  const res = await doInstance.fetch(
    new Request('https://channel-do/fan-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, channelUserId }),
    }),
  );
  return res.json() as Promise<{ inserted: number }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelSubscriberDO.fetch', () => {
  it('returns 400 for a malformed payload', async () => {
    const { do: doInstance } = makeDO();
    const res = await doInstance.fetch(
      new Request('https://channel-do/fan-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: 'v1' }), // missing channelUserId
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown paths', async () => {
    const { do: doInstance } = makeDO();
    const res = await doInstance.fetch(new Request('https://channel-do/unknown'));
    expect(res.status).toBe(404);
  });

  it('inserts 0 rows for a channel with no subscribers', async () => {
    const { do: doInstance, inserts } = makeDO([]);
    const body = await fanOutRequest(doInstance, 'v1', 'ch1');
    expect(body.inserted).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('inserts one inbox row per subscriber on a single page', async () => {
    const subs = ['u1', 'u2', 'u3'];
    const { do: doInstance, inserts } = makeDO(subs);
    const body = await fanOutRequest(doInstance, 'v1', 'ch1');
    expect(body.inserted).toBe(subs.length);
    expect(inserts).toHaveLength(subs.length);
    // Each insert carries (subscriberId, videoId, channelUserId)
    const subscriberIds = inserts.map(([sub]) => sub).sort();
    expect(subscriberIds).toEqual([...subs].sort());
    for (const [, vid, ch] of inserts) {
      expect(vid).toBe('v1');
      expect(ch).toBe('ch1');
    }
  });

  it('pages through subscribers when the count exceeds the batch size (200)', async () => {
    // 201 subscribers forces a second page read.
    const subs = Array.from({ length: 201 }, (_, i) =>
      `user-${String(i).padStart(4, '0')}`,
    );
    const { do: doInstance, inserts } = makeDO(subs);
    const body = await fanOutRequest(doInstance, 'v-big', 'ch-big');
    expect(body.inserted).toBe(201);
    expect(inserts).toHaveLength(201);
    const ids = inserts.map(([sub]) => sub).sort();
    expect(ids).toEqual([...subs].sort());
  });

  it('stops after an exactly full first page (200 rows)', async () => {
    const subs = Array.from({ length: 200 }, (_, i) =>
      `user-${String(i).padStart(4, '0')}`,
    );
    const { do: doInstance, inserts } = makeDO(subs);
    const body = await fanOutRequest(doInstance, 'v-exact', 'ch-exact');
    expect(body.inserted).toBe(200);
    expect(inserts).toHaveLength(200);
  });
});

describe('triggerFanOut', () => {
  it('is a no-op when the binding is undefined', async () => {
    await expect(
      triggerFanOut(undefined, { videoId: 'v', channelUserId: 'c' }),
    ).resolves.toBeUndefined();
  });

  it('calls the DO stub with the payload', async () => {
    let called = false;
    const fakeNs = {
      idFromName: () => 'fake-id',
      get: () => ({
        fetch: async () => {
          called = true;
          return Response.json({ inserted: 1 });
        },
      }),
    } as unknown as Parameters<typeof triggerFanOut>[0];
    await triggerFanOut(fakeNs, { videoId: 'v1', channelUserId: 'c1' });
    expect(called).toBe(true);
  });

  it('swallows errors so fan-out never blocks the caller', async () => {
    const fakeNs = {
      idFromName: () => 'fake-id',
      get: () => ({
        fetch: async () => {
          throw new Error('network failure');
        },
      }),
    } as unknown as Parameters<typeof triggerFanOut>[0];
    await expect(
      triggerFanOut(fakeNs, { videoId: 'v1', channelUserId: 'c1' }),
    ).resolves.toBeUndefined();
  });
});
