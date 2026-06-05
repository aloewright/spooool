import { describe, expect, it, vi } from 'vitest';
import { aiCostStatement, writeAiCost, type AiCostEntry } from './ai-costs';

const SAMPLE_ENTRY: AiCostEntry = {
  userId: 'u_abc',
  op: 'image_gen',
  route: 'dynamic/image_gen',
  model: '@cf/black-forest-labs/flux-1-schnell',
  units: 1,
  unitKind: 'images',
  estUsd: 0.0013,
};

function fakeDb() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const makeStmt = (sql: string) => {
    let boundValues: unknown[] = [];
    return {
      sql,
      bind(...args: unknown[]) {
        boundValues = args;
        return this;
      },
      async run() {
        runs.push({ sql, binds: [...boundValues] });
        return {};
      },
    };
  };
  return {
    prepare: (sql: string) => makeStmt(sql) as unknown as D1PreparedStatement,
    _runs: runs,
  } as unknown as { prepare: (s: string) => D1PreparedStatement; _runs: typeof runs } & D1Database;
}

describe('aiCostStatement', () => {
  it('returns a prepared statement with the correct SQL and bound values', () => {
    const db = fakeDb();
    const stmt = aiCostStatement({ DB: db }, SAMPLE_ENTRY) as unknown as {
      sql: string;
      _binds?: unknown[];
      bind: (...a: unknown[]) => { sql: string };
    };
    expect(stmt.sql).toContain('INSERT INTO ai_costs');
    expect(stmt.sql).toContain('unit_kind');
    expect(stmt.sql).toContain('est_usd');
  });

  it('sets project_id to null when omitted', () => {
    const db = fakeDb();
    // Capture the bind call
    const captured: unknown[][] = [];
    const origPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as { bind: (...a: unknown[]) => unknown; run: () => Promise<unknown> };
      const origBind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => {
        captured.push(args);
        return origBind(...args);
      };
      return stmt;
    };
    aiCostStatement({ DB: db }, SAMPLE_ENTRY);
    expect(captured).toHaveLength(1);
    // project_id is the 9th positional bind (index 8)
    const binds = captured[0];
    expect(binds[8]).toBeNull();
  });

  it('passes projectId through when provided', () => {
    const db = fakeDb();
    const captured: unknown[][] = [];
    const origPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as { bind: (...a: unknown[]) => unknown; run: () => Promise<unknown> };
      const origBind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => {
        captured.push(args);
        return origBind(...args);
      };
      return stmt;
    };
    aiCostStatement({ DB: db }, { ...SAMPLE_ENTRY, projectId: 'proj_1' });
    expect(captured[0][8]).toBe('proj_1');
  });
});

describe('writeAiCost', () => {
  it('executes the INSERT and records the expected field values', async () => {
    const db = fakeDb();
    await writeAiCost({ DB: db }, SAMPLE_ENTRY);

    expect(db._runs).toHaveLength(1);
    const { sql, binds } = db._runs[0];
    expect(sql).toContain('INSERT INTO ai_costs');

    // id (index 0): matches c_<16hex> pattern
    expect(String(binds[0])).toMatch(/^c_[0-9a-f]{16}$/);
    // user_id (1)
    expect(binds[1]).toBe('u_abc');
    // op (2)
    expect(binds[2]).toBe('image_gen');
    // route (3)
    expect(binds[3]).toBe('dynamic/image_gen');
    // model (4)
    expect(binds[4]).toBe('@cf/black-forest-labs/flux-1-schnell');
    // units (5)
    expect(binds[5]).toBe(1);
    // unit_kind (6)
    expect(binds[6]).toBe('images');
    // est_usd (7)
    expect(binds[7]).toBeCloseTo(0.0013, 6);
    // project_id (8)
    expect(binds[8]).toBeNull();
    // created_at (9): recent ms timestamp
    expect(typeof binds[9]).toBe('number');
    expect(Number(binds[9])).toBeGreaterThan(0);
  });

  it('generates a unique id per call', async () => {
    const db = fakeDb();
    await writeAiCost({ DB: db }, SAMPLE_ENTRY);
    await writeAiCost({ DB: db }, SAMPLE_ENTRY);
    const ids = db._runs.map((r) => r.binds[0]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('propagates D1 errors', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => { throw new Error('D1 write failure'); },
        }),
      }),
    } as unknown as D1Database;
    await expect(writeAiCost({ DB: db }, SAMPLE_ENTRY)).rejects.toThrow('D1 write failure');
  });
});
