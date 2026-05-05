import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildFtsQuery, searchRoutes, type SearchEnv } from './search';

describe('buildFtsQuery', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
  });

  it('wraps tokens in quotes with prefix wildcard', () => {
    expect(buildFtsQuery('hello world')).toBe('"hello"* "world"*');
  });

  it('strips fts5 syntax characters from tokens', () => {
    expect(buildFtsQuery('hel"lo* world(ish)')).toBe('"hello"* "worldish"*');
    expect(buildFtsQuery('title:foo')).toBe('"titlefoo"*');
  });

  it('drops tokens that become empty after sanitisation', () => {
    expect(buildFtsQuery('"" hello')).toBe('"hello"*');
    expect(buildFtsQuery('***')).toBeNull();
  });

  it('caps token count to limit pathological inputs', () => {
    const huge = Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ');
    const out = buildFtsQuery(huge);
    expect(out).not.toBeNull();
    expect(out?.split(' ')).toHaveLength(8);
  });
});

interface SuggestRow {
  id: string;
  title: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  channel_username: string | null;
  rank: number;
}

interface FakeStmt {
  bind: (...values: unknown[]) => FakeStmt;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean }>;
}

function fakeDB(rows: SuggestRow[]): { db: D1Database; binds: unknown[][] } {
  const binds: unknown[][] = [];
  const prepare = (_sql: string): FakeStmt => {
    const stmt: FakeStmt = {
      bind: (...values) => {
        binds.push(values);
        return stmt;
      },
      first: async () => null,
      all: async <T,>() => ({ results: rows as T[] }),
      run: async () => ({ success: true }),
    };
    return stmt;
  };
  return { db: { prepare } as unknown as D1Database, binds };
}

function buildApp(env: SearchEnv) {
  const app = new Hono<{ Bindings: SearchEnv; Variables: { user: null } }>();
  app.use('*', async (c, next) => {
    c.set('user', null);
    await next();
  });
  app.route('/', searchRoutes);
  return (path: string) => app.request(path, {}, env);
}

describe('GET /api/videos/search/suggest', () => {
  it('400s on missing or oversized q', async () => {
    const { db } = fakeDB([]);
    const request = buildApp({ DB: db });
    expect((await request('/api/videos/search/suggest')).status).toBe(400);
    expect((await request(`/api/videos/search/suggest?q=${'x'.repeat(100)}`)).status).toBe(400);
  });

  it('400s when limit exceeds 10', async () => {
    const { db } = fakeDB([]);
    const res = await buildApp({ DB: db })('/api/videos/search/suggest?q=foo&limit=99');
    expect(res.status).toBe(400);
  });

  it('returns empty suggestions when the query sanitises to nothing', async () => {
    const { db } = fakeDB([]);
    const res = await buildApp({ DB: db })('/api/videos/search/suggest?q=***');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: unknown[] };
    expect(body.suggestions).toEqual([]);
  });

  it('returns FTS-ranked suggestions and binds the right limit', async () => {
    const rows: SuggestRow[] = [
      {
        id: 'v1',
        title: 'pasta basics',
        thumbnail_url: null,
        channel_name: 'Alice',
        channel_username: 'alice',
        rank: -1.2,
      },
    ];
    const { db, binds } = fakeDB(rows);
    const res = await buildApp({ DB: db })('/api/videos/search/suggest?q=pasta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: SuggestRow[]; limit: number };
    expect(body.limit).toBe(6);
    expect(body.suggestions).toHaveLength(1);
    // bind shape: (ftsQuery, limit) — the explicit default lands on the bind.
    expect(binds[0]?.[1]).toBe(6);
  });

  it('honours a custom limit within the cap', async () => {
    const { db, binds } = fakeDB([]);
    await buildApp({ DB: db })('/api/videos/search/suggest?q=foo&limit=3');
    expect(binds[0]?.[1]).toBe(3);
  });
});
