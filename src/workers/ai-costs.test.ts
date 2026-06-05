import { describe, expect, it, vi } from 'vitest';
import { writeAiCost, type AiCostEntry, type AiCostsDbEnv } from './ai-costs';

function makeDbStub() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];

  const makeStmt = (sql: string) => {
    let boundValues: unknown[] = [];
    const stmt: Record<string, unknown> = {
      sql,
      bind: (...args: unknown[]) => {
        boundValues = args;
        return stmt;
      },
      run: vi.fn(async () => {
        runs.push({ sql, binds: [...boundValues] });
        return {};
      }),
    };
    return stmt;
  };

  return {
    db: { prepare: (sql: string) => makeStmt(sql) } as unknown as AiCostsDbEnv['DB'],
    runs,
  };
}

describe('writeAiCost', () => {
  it('inserts a row with all required columns', async () => {
    const { db, runs } = makeDbStub();
    const entry: AiCostEntry = {
      userId: 'u_abc',
      op: 'image_gen',
      route: 'dynamic/image_gen',
      model: '@cf/black-forest-labs/flux-1-schnell',
      units: 1,
      unitKind: 'images',
      estUsd: 0.0013,
    };
    await writeAiCost({ DB: db }, entry);

    expect(runs).toHaveLength(1);
    const { sql, binds } = runs[0];
    expect(sql).toContain('INSERT INTO ai_costs');
    expect(sql).toContain('unit_kind');

    // id at index 0 matches c_ prefix + 16 hex chars
    expect(binds[0]).toMatch(/^c_[0-9a-f]{16}$/);
    expect(binds[1]).toBe('u_abc');           // user_id
    expect(binds[2]).toBe('image_gen');        // op
    expect(binds[3]).toBe('dynamic/image_gen'); // route
    expect(binds[4]).toBe('@cf/black-forest-labs/flux-1-schnell'); // model
    expect(binds[5]).toBe(1);                 // units
    expect(binds[6]).toBe('images');           // unit_kind
    expect(binds[7]).toBe(0.0013);            // est_usd
    expect(binds[8]).toBeNull();              // project_id defaults to null
    expect(typeof binds[9]).toBe('number');   // created_at is a ms timestamp
  });

  it('propagates projectId when provided', async () => {
    const { db, runs } = makeDbStub();
    await writeAiCost({ DB: db }, {
      userId: 'u1',
      op: 'video_gen',
      route: 'dynamic/video_gen',
      model: 'google/veo-3.1',
      units: 8,
      unitKind: 'seconds',
      estUsd: 0.4,
      projectId: 'proj_42',
    });
    expect(runs[0].binds[8]).toBe('proj_42');
  });

  it('generates a unique id for each call', async () => {
    const { db, runs } = makeDbStub();
    const entry: AiCostEntry = {
      userId: 'u1', op: 'image_gen', route: 'r', model: 'm',
      units: 1, unitKind: 'images', estUsd: 0.001,
    };
    await writeAiCost({ DB: db }, entry);
    await writeAiCost({ DB: db }, entry);
    expect(runs[0].binds[0]).not.toBe(runs[1].binds[0]);
  });

  it('records created_at as a positive ms timestamp', async () => {
    const { db, runs } = makeDbStub();
    const before = Date.now();
    await writeAiCost({ DB: db }, {
      userId: 'u1', op: 'image_gen', route: 'r', model: 'm',
      units: 1, unitKind: 'images', estUsd: 0.001,
    });
    const after = Date.now();
    const ts = runs[0].binds[9] as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
