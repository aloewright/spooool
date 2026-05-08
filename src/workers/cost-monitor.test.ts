import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATES,
  estimateCosts,
  formatAlertEmail,
  getCreatorCostAttribution,
  listCostSnapshots,
  pickAlertRecipient,
  ratesFromEnv,
  runCostSnapshot,
  totalFromBreakdown,
  type CostMonitorEnv,
} from './cost-monitor';

const BYTES_PER_GB = 1024 ** 3;

interface RunResult {
  rowsRun: Array<{ sql: string; params: unknown[] }>;
}

function makeFakeDB(args: {
  storageBytes: number;
  activeCreators: number;
  alertedAtBefore?: number | null;
  creators?: Array<{ user_id: string; email: string | null; storage_bytes: number; video_count: number }>;
  snapshots?: Array<Record<string, unknown>>;
  recordRun?: RunResult;
}): D1Database {
  const recordRun = args.recordRun;
  const make = (sql: string): D1PreparedStatement => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...params: unknown[]) => {
        bound = params;
        return stmt;
      },
      first: async <T,>() => {
        if (/FROM videos/i.test(sql)) {
          return { storage_bytes: args.storageBytes, active_creators: args.activeCreators } as T;
        }
        if (/SELECT alerted_at FROM cost_snapshots/i.test(sql)) {
          return { alerted_at: args.alertedAtBefore ?? null } as T;
        }
        return null as unknown as T;
      },
      all: async <T,>() => {
        if (/FROM cost_snapshots/i.test(sql)) {
          return { results: (args.snapshots ?? []) as T[] };
        }
        if (/FROM videos v/i.test(sql)) {
          return { results: (args.creators ?? []) as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => {
        if (recordRun) recordRun.rowsRun.push({ sql, params: bound });
        return { success: true } as unknown;
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

describe('estimateCosts', () => {
  it('computes storage cost from bytes via per-GB rate', () => {
    const out = estimateCosts(
      { storageBytes: 10 * BYTES_PER_GB, egressBytes: 0, streamHours: 0 },
      DEFAULT_RATES,
    );
    // 10 GB * 1.5 cents = 15
    expect(out.storageCents).toBe(15);
    expect(out.egressCents).toBe(0);
  });

  it('computes stream cost from delivered hours', () => {
    const out = estimateCosts(
      { storageBytes: 0, egressBytes: 0, streamHours: 3 },
      { ...DEFAULT_RATES, streamMinutePerHourCents: 200 },
    );
    expect(out.streamCents).toBe(600);
  });
});

describe('totalFromBreakdown', () => {
  it('sums components when no override', () => {
    expect(totalFromBreakdown({ storageCents: 10, egressCents: 5, streamCents: 2 })).toBe(17);
  });

  it('returns override when provided', () => {
    expect(
      totalFromBreakdown({ storageCents: 10, egressCents: 5, streamCents: 2, overrideCents: 999 }),
    ).toBe(999);
  });
});

describe('ratesFromEnv', () => {
  it('falls back to defaults when env is empty', () => {
    expect(ratesFromEnv({} as CostMonitorEnv)).toEqual(DEFAULT_RATES);
  });

  it('honors numeric overrides', () => {
    const r = ratesFromEnv({
      COST_RATE_STORAGE_PER_GB_CENTS: '2',
      COST_RATE_EGRESS_PER_GB_CENTS: '0.5',
    } as CostMonitorEnv);
    expect(r.storagePerGbCents).toBe(2);
    expect(r.egressPerGbCents).toBe(0.5);
  });

  it('rejects non-numeric overrides', () => {
    const r = ratesFromEnv({ COST_RATE_STORAGE_PER_GB_CENTS: 'abc' } as CostMonitorEnv);
    expect(r.storagePerGbCents).toBe(DEFAULT_RATES.storagePerGbCents);
  });
});

describe('pickAlertRecipient', () => {
  it('prefers COST_ALERT_EMAIL', () => {
    expect(
      pickAlertRecipient({
        COST_ALERT_EMAIL: 'cost@example.com',
        ADMIN_EMAILS: 'a@b.com',
      } as CostMonitorEnv),
    ).toBe('cost@example.com');
  });

  it('falls back to first ADMIN_EMAILS entry', () => {
    expect(
      pickAlertRecipient({ ADMIN_EMAILS: 'first@x.com, second@x.com' } as CostMonitorEnv),
    ).toBe('first@x.com');
  });

  it('returns null when nothing is configured', () => {
    expect(pickAlertRecipient({} as CostMonitorEnv)).toBeNull();
  });
});

describe('formatAlertEmail', () => {
  it('renders subject and html with dollar amounts', () => {
    const { subject, html } = formatAlertEmail({
      totalUsdCents: 600_000,
      thresholdUsdCents: 500_000,
      snapshotDate: '2026-01-01',
      breakdown: { storageCents: 100, egressCents: 0, streamCents: 50 },
    });
    expect(subject).toContain('2026-01-01');
    expect(subject).toContain('$6000.00');
    expect(html).toContain('$5000.00');
    expect(html).toContain('$1.00'); // storage
  });
});

describe('runCostSnapshot', () => {
  it('writes a snapshot and skips alerting when below threshold', async () => {
    const recordRun: RunResult = { rowsRun: [] };
    const db = makeFakeDB({ storageBytes: 1 * BYTES_PER_GB, activeCreators: 1, recordRun });
    const env: CostMonitorEnv = {
      DB: db,
      COST_ALERT_THRESHOLD_USD_CENTS: '100000',
    };
    const r = await runCostSnapshot(env, new Date('2026-01-15T00:00:00Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alerted).toBe(false);
    expect(r.snapshot.snapshotDate).toBe('2026-01-15');
    expect(r.snapshot.totalUsdCents).toBe(2); // 1GB * 1.5 = 1.5 -> rounds to 2
    expect(recordRun.rowsRun.some((r) => /INSERT INTO cost_snapshots/.test(r.sql))).toBe(true);
  });

  it('skips alert when no recipient is configured', async () => {
    const db = makeFakeDB({ storageBytes: 10_000 * BYTES_PER_GB, activeCreators: 5 });
    const env: CostMonitorEnv = {
      DB: db,
      COST_ALERT_THRESHOLD_USD_CENTS: '1', // force over-threshold
      RESEND_API_KEY: 'irrelevant',
    };
    const r = await runCostSnapshot(env, new Date('2026-02-01T00:00:00Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alerted).toBe(false);
    expect(r.alertSkippedReason).toBe('no recipient configured');
  });

  it('does not re-alert when alerted_at is already set', async () => {
    const db = makeFakeDB({
      storageBytes: 10_000 * BYTES_PER_GB,
      activeCreators: 5,
      alertedAtBefore: 12345,
    });
    const env: CostMonitorEnv = {
      DB: db,
      COST_ALERT_THRESHOLD_USD_CENTS: '1',
      ADMIN_EMAILS: 'admin@example.com',
      RESEND_API_KEY: 'k',
    };
    const r = await runCostSnapshot(env, new Date('2026-02-01T00:00:00Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alerted).toBe(false);
  });

  it('honors the CF_BILLING_USD_CENTS_OVERRIDE for total', async () => {
    const db = makeFakeDB({ storageBytes: 0, activeCreators: 0 });
    const env: CostMonitorEnv = {
      DB: db,
      CF_BILLING_USD_CENTS_OVERRIDE: '4242',
    };
    const r = await runCostSnapshot(env, new Date('2026-03-01T00:00:00Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.totalUsdCents).toBe(4242);
  });
});

describe('getCreatorCostAttribution', () => {
  it('returns rows with estimated cost from per-user storage', async () => {
    const db = makeFakeDB({
      storageBytes: 0,
      activeCreators: 0,
      creators: [
        { user_id: 'u1', email: 'a@x.com', storage_bytes: 100 * BYTES_PER_GB, video_count: 4 },
        { user_id: 'u2', email: null, storage_bytes: 0, video_count: 0 },
      ],
    });
    const rows = await getCreatorCostAttribution({ DB: db } as CostMonitorEnv, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ userId: 'u1', videos: 4 });
    expect(rows[0].estimatedUsdCents).toBe(150); // 100 * 1.5
    expect(rows[1].estimatedUsdCents).toBe(0);
  });

  it('clamps the limit', async () => {
    const db = makeFakeDB({ storageBytes: 0, activeCreators: 0, creators: [] });
    await expect(
      getCreatorCostAttribution({ DB: db } as CostMonitorEnv, 999_999),
    ).resolves.toEqual([]);
  });
});

describe('listCostSnapshots', () => {
  it('parses breakdown_json into a structured object', async () => {
    const db = makeFakeDB({
      storageBytes: 0,
      activeCreators: 0,
      snapshots: [
        {
          snapshot_date: '2026-01-01',
          total_usd_cents: 100,
          storage_bytes: 1024,
          active_creators: 2,
          breakdown_json: JSON.stringify({ storageCents: 80, egressCents: 0, streamCents: 20 }),
          alerted_at: null,
          created_at: 0,
        },
      ],
    });
    const out = await listCostSnapshots({ DB: db } as CostMonitorEnv, 5);
    expect(out[0].breakdown.storageCents).toBe(80);
    expect(out[0].breakdown.streamCents).toBe(20);
  });

  it('tolerates malformed breakdown json', async () => {
    const db = makeFakeDB({
      storageBytes: 0,
      activeCreators: 0,
      snapshots: [
        {
          snapshot_date: '2026-01-02',
          total_usd_cents: 0,
          storage_bytes: 0,
          active_creators: 0,
          breakdown_json: 'not-json',
          alerted_at: null,
          created_at: 0,
        },
      ],
    });
    const out = await listCostSnapshots({ DB: db } as CostMonitorEnv, 5);
    expect(out[0].breakdown).toEqual({ storageCents: 0, egressCents: 0, streamCents: 0 });
  });
});
