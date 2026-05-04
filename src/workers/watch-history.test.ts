import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { watchHistoryRoutes, type WatchHistoryEnv } from './watch-history';

interface FakeStmt {
  bind: (...values: unknown[]) => FakeStmt;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ success: boolean }>;
  all: <T>() => Promise<{ results: T[] }>;
}

interface FakeDBSpec {
  videoExists?: boolean;
  historyRows?: unknown[];
}

interface FakeDBResult {
  db: D1Database;
  prepares: string[];
  binds: unknown[][];
}

function fakeDB(spec: FakeDBSpec): FakeDBResult {
  const prepares: string[] = [];
  const binds: unknown[][] = [];
  const prepare = (sql: string): FakeStmt => {
    prepares.push(sql);
    const stmt: FakeStmt = {
      bind: (...values) => {
        binds.push(values);
        return stmt;
      },
      first: async () => {
        if (sql.includes('FROM videos')) {
          return spec.videoExists ? ({ '1': 1 } as never) : null;
        }
        return null;
      },
      run: async () => ({ success: true }),
      all: async () => ({ results: (spec.historyRows ?? []) as never[] }),
    };
    return stmt;
  };
  return {
    db: { prepare } as unknown as D1Database,
    prepares,
    binds,
  };
}

type SessionUser = { id: string } | null;

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: WatchHistoryEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', watchHistoryRoutes);
  return app;
}

describe('POST /api/users/me/history', () => {
  it('401s when there is no session', async () => {
    const { db } = fakeDB({});
    const res = await buildApp(null).request(
      '/api/users/me/history',
      {
        method: 'POST',
        body: JSON.stringify({ videoId: 'v1' }),
        headers: { 'content-type': 'application/json' },
      },
      { DB: db },
    );
    expect(res.status).toBe(401);
  });

  it('400s on missing or oversized videoId', async () => {
    const { db } = fakeDB({});
    const app = buildApp({ id: 'u1' });
    const empty = await app.request(
      '/api/users/me/history',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
      { DB: db },
    );
    expect(empty.status).toBe(400);
    const tooLong = await app.request(
      '/api/users/me/history',
      {
        method: 'POST',
        body: JSON.stringify({ videoId: 'a'.repeat(200) }),
        headers: { 'content-type': 'application/json' },
      },
      { DB: db },
    );
    expect(tooLong.status).toBe(400);
  });

  it('404s when the video is not viewable', async () => {
    const { db } = fakeDB({ videoExists: false });
    const res = await buildApp({ id: 'u1' }).request(
      '/api/users/me/history',
      {
        method: 'POST',
        body: JSON.stringify({ videoId: 'gone' }),
        headers: { 'content-type': 'application/json' },
      },
      { DB: db },
    );
    expect(res.status).toBe(404);
  });

  it('204s on successful UPSERT and binds (user_id, video_id)', async () => {
    const { db, prepares, binds } = fakeDB({ videoExists: true });
    const res = await buildApp({ id: 'user_abc' }).request(
      '/api/users/me/history',
      {
        method: 'POST',
        body: JSON.stringify({ videoId: 'v1' }),
        headers: { 'content-type': 'application/json' },
      },
      { DB: db },
    );
    expect(res.status).toBe(204);
    expect(prepares.length).toBe(2);
    expect(prepares[1]).toContain('INSERT INTO watch_history');
    expect(prepares[1]).toContain('ON CONFLICT(user_id, video_id) DO UPDATE');
    expect(binds[binds.length - 1]).toEqual(['user_abc', 'v1']);
  });
});

describe('GET /api/users/me/history', () => {
  it('401s when unauthenticated', async () => {
    const { db } = fakeDB({});
    const res = await buildApp(null).request('/api/users/me/history', {}, { DB: db });
    expect(res.status).toBe(401);
  });

  it('returns the list joined with video metadata', async () => {
    const rows = [
      {
        video_id: 'v1',
        watched_at: '2026-05-04 12:00:00',
        title: 'First',
        thumbnail_url: 'https://x/t.jpg',
        view_count: 42,
        channel_name: 'Alice',
        channel_username: 'alice',
      },
    ];
    const { db } = fakeDB({ historyRows: rows });
    const res = await buildApp({ id: 'u1' }).request(
      '/api/users/me/history',
      {},
      { DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: typeof rows };
    expect(body.items).toEqual(rows);
  });

  it('400s when limit exceeds MAX_LIMIT (50)', async () => {
    const { db } = fakeDB({ historyRows: [] });
    const res = await buildApp({ id: 'u1' }).request(
      '/api/users/me/history?limit=999',
      {},
      { DB: db },
    );
    expect(res.status).toBe(400);
  });

  it('uses default limit of 12 when none provided', async () => {
    const { db, binds } = fakeDB({ historyRows: [] });
    await buildApp({ id: 'u1' }).request('/api/users/me/history', {}, { DB: db });
    expect(binds[binds.length - 1]).toEqual(['u1', 12]);
  });

  it('filters out non-ready / hidden / DMCA-disabled / deleted videos at query time', async () => {
    const { db, prepares } = fakeDB({ historyRows: [] });
    await buildApp({ id: 'u1' }).request('/api/users/me/history', {}, { DB: db });
    const sql = prepares[0];
    expect(sql).toContain('v.deleted_at IS NULL');
    expect(sql).toContain('v.hidden_at IS NULL');
    expect(sql).toContain("v.status = 'ready'");
    expect(sql).toContain("v.dmca_status IS NULL OR v.dmca_status != 'disabled'");
  });
});

describe('DELETE /api/users/me/history', () => {
  it('401s when unauthenticated', async () => {
    const { db } = fakeDB({});
    const res = await buildApp(null).request(
      '/api/users/me/history',
      { method: 'DELETE' },
      { DB: db },
    );
    expect(res.status).toBe(401);
  });

  it('204s and runs a DELETE bound to the calling user', async () => {
    const { db, prepares, binds } = fakeDB({});
    const res = await buildApp({ id: 'u1' }).request(
      '/api/users/me/history',
      { method: 'DELETE' },
      { DB: db },
    );
    expect(res.status).toBe(204);
    expect(prepares[0]).toContain('DELETE FROM watch_history WHERE user_id = ?');
    expect(binds[0]).toEqual(['u1']);
  });
});
