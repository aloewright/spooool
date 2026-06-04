import { describe, expect, it, vi } from 'vitest';
import { aiCostStatement, writeAiCost, type AiCostInput } from './ai-costs';

// ──────────────────────────────────────────────────────────────────────────────
// Stub builder
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns a fake D1Database that captures prepare/bind/run calls so we can
 * assert that aiCostStatement produces the right SQL and bind values.
 */
function makeDbStub() {
  const preparedSqls: string[] = [];
  const boundValues: unknown[][] = [];
  const runMock = vi.fn(async () => ({}));

  // Each prepare() call records the SQL and returns a builder whose bind()
  // records args and run() delegates to the shared runMock.
  const db = {
    prepare(sql: string): Record<string, unknown> {
      preparedSqls.push(sql);
      const stmt: Record<string, unknown> = {};
      stmt['bind'] = (...args: unknown[]) => {
        boundValues.push(args);
        return stmt;
      };
      stmt['run'] = runMock;
      return stmt;
    },
    _preparedSqls: preparedSqls,
    _boundValues: boundValues,
    _runMock: runMock,
  };
  return db as unknown as D1Database & {
    _preparedSqls: string[];
    _boundValues: unknown[][];
    _runMock: ReturnType<typeof vi.fn>;
  };
}

const SAMPLE_INPUT: AiCostInput = {
  userId: 'u_abc123',
  op: 'image_gen',
  route: 'dynamic/image_gen',
  model: '@cf/black-forest-labs/flux-1-schnell',
  units: 1,
  unitKind: 'images',
  estUsd: 0.0013,
  projectId: null,
};

// ──────────────────────────────────────────────────────────────────────────────
// aiCostStatement
// ──────────────────────────────────────────────────────────────────────────────

describe('aiCostStatement', () => {
  it('produces an INSERT INTO ai_costs statement', () => {
    const db = makeDbStub();
    aiCostStatement(db as unknown as D1Database, SAMPLE_INPUT);
    expect(db._preparedSqls[0]).toContain('INSERT INTO ai_costs');
  });

  it('includes all 10 column names in the correct order', () => {
    const db = makeDbStub();
    aiCostStatement(db as unknown as D1Database, SAMPLE_INPUT);
    const sql = db._preparedSqls[0];
    expect(sql).toContain('id');
    expect(sql).toContain('user_id');
    expect(sql).toContain('op');
    expect(sql).toContain('route');
    expect(sql).toContain('model');
    expect(sql).toContain('units');
    expect(sql).toContain('unit_kind');
    expect(sql).toContain('est_usd');
    expect(sql).toContain('project_id');
    expect(sql).toContain('created_at');
  });

  it('binds values in the right order: id, userId, op, route, model, units, unitKind, estUsd, projectId, createdAt', () => {
    const db = makeDbStub();
    aiCostStatement(db as unknown as D1Database, SAMPLE_INPUT);
    const binds = db._boundValues[0];
    expect(binds).toHaveLength(10);
    // index 0: id — c_ prefix, 16 hex chars
    expect(String(binds[0])).toMatch(/^c_[0-9a-f]{16}$/);
    // index 1: userId
    expect(binds[1]).toBe(SAMPLE_INPUT.userId);
    // index 2: op
    expect(binds[2]).toBe(SAMPLE_INPUT.op);
    // index 3: route
    expect(binds[3]).toBe(SAMPLE_INPUT.route);
    // index 4: model
    expect(binds[4]).toBe(SAMPLE_INPUT.model);
    // index 5: units
    expect(binds[5]).toBe(SAMPLE_INPUT.units);
    // index 6: unitKind
    expect(binds[6]).toBe(SAMPLE_INPUT.unitKind);
    // index 7: estUsd
    expect(binds[7]).toBe(SAMPLE_INPUT.estUsd);
    // index 8: projectId (null when not supplied)
    expect(binds[8]).toBeNull();
    // index 9: created_at — integer milliseconds
    expect(typeof binds[9]).toBe('number');
    expect(Number(binds[9])).toBeGreaterThan(0);
  });

  it('uses the supplied projectId when provided', () => {
    const db = makeDbStub();
    aiCostStatement(db as unknown as D1Database, { ...SAMPLE_INPUT, projectId: 'p_proj01' });
    const binds = db._boundValues[0];
    expect(binds[8]).toBe('p_proj01');
  });

  it('generates unique ids on each call', () => {
    const db1 = makeDbStub();
    const db2 = makeDbStub();
    aiCostStatement(db1 as unknown as D1Database, SAMPLE_INPUT);
    aiCostStatement(db2 as unknown as D1Database, SAMPLE_INPUT);
    const id1 = String(db1._boundValues[0][0]);
    const id2 = String(db2._boundValues[0][0]);
    expect(id1).not.toBe(id2);
  });

  it('does NOT call run() — returns statement for batching', () => {
    const db = makeDbStub();
    aiCostStatement(db as unknown as D1Database, SAMPLE_INPUT);
    expect(db._runMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeAiCost
// ──────────────────────────────────────────────────────────────────────────────

describe('writeAiCost', () => {
  it('calls run() exactly once', async () => {
    const db = makeDbStub();
    await writeAiCost(db as unknown as D1Database, SAMPLE_INPUT);
    expect(db._runMock).toHaveBeenCalledTimes(1);
  });

  it('prepares the correct INSERT INTO ai_costs SQL', async () => {
    const db = makeDbStub();
    await writeAiCost(db as unknown as D1Database, SAMPLE_INPUT);
    expect(db._preparedSqls[0]).toContain('INSERT INTO ai_costs');
  });

  it('binds userId at index 1', async () => {
    const db = makeDbStub();
    await writeAiCost(db as unknown as D1Database, { ...SAMPLE_INPUT, userId: 'u_video99' });
    expect(db._boundValues[0][1]).toBe('u_video99');
  });

  it('binds unitKind=seconds for video_gen ops', async () => {
    const db = makeDbStub();
    await writeAiCost(db as unknown as D1Database, {
      userId: 'u_v1',
      op: 'video_gen',
      route: 'dynamic/video_gen',
      model: 'google/veo-3.1',
      units: 8,
      unitKind: 'seconds',
      estUsd: 0.4,
    });
    expect(db._boundValues[0][6]).toBe('seconds');
  });
});
