import { describe, expect, it, vi } from 'vitest';
import {
  buildCostAlertProps,
  evaluateAlerts,
  getCostSnapshot,
  parseAiSpendThreshold,
  parseThresholdBytes,
  runCostMonitorSweep,
  todayKey,
  type CostSnapshot,
  type CostsEnv,
} from './costs';

// Factory for a fake D1Database that returns canned scalar rows in the order
// getCostSnapshot fires its prepare() calls. Each `.first<T>()` consumes the
// next entry in `queue`; if the queue runs dry the test gets a clear error.
function fakeDb(queue: unknown[]): D1Database {
  let i = 0;
  return {
    prepare(_sql: string) {
      const builder = {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds.push(...args);
          return this;
        },
        async first<T>() {
          if (i >= queue.length) throw new Error(`fakeDb: no row queued for call ${i}`);
          return queue[i++] as T;
        },
        async run() {
          if (i >= queue.length) throw new Error(`fakeDb: no row queued for call ${i}`);
          return queue[i++];
        },
        async all<T>() {
          if (i >= queue.length) throw new Error(`fakeDb: no row queued for call ${i}`);
          return { results: [queue[i++] as T] };
        },
      };
      return builder as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function fakeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

const SAMPLE_SNAPSHOT: CostSnapshot = {
  generated_at: '2026-05-13T00:00:00.000Z',
  storage: { used_bytes: 100 * 1024 * 1024 * 1024, used_gib: 100, estimated_monthly_usd: 1.5 },
  ai_spend: { total_usd: 0 },
  videos: { total: 42, soft_deleted: 1, last_30d: 5 },
  users: { total: 7, last_30d: 2 },
  comments: { total: 12 },
};

describe('parseAiSpendThreshold', () => {
  it('defaults to $50 when undefined', () => {
    expect(parseAiSpendThreshold(undefined)).toBe(50);
  });

  it('defaults when the value is not a positive number', () => {
    expect(parseAiSpendThreshold('not-a-number')).toBe(50);
    expect(parseAiSpendThreshold('0')).toBe(50);
    expect(parseAiSpendThreshold('-5')).toBe(50);
  });

  it('accepts a positive numeric override', () => {
    expect(parseAiSpendThreshold('25')).toBe(25);
  });
});

describe('parseThresholdBytes', () => {
  it('defaults to 100 GiB when undefined', () => {
    expect(parseThresholdBytes(undefined)).toBe(100 * 1024 * 1024 * 1024);
  });

  it('defaults when the value is not a positive number', () => {
    expect(parseThresholdBytes('not-a-number')).toBe(100 * 1024 * 1024 * 1024);
    expect(parseThresholdBytes('0')).toBe(100 * 1024 * 1024 * 1024);
    expect(parseThresholdBytes('-5')).toBe(100 * 1024 * 1024 * 1024);
  });

  it('accepts a positive numeric override', () => {
    expect(parseThresholdBytes('50000000000')).toBe(50_000_000_000);
  });
});

describe('evaluateAlerts', () => {
  it('returns no alerts below the threshold', () => {
    const small: CostSnapshot = { ...SAMPLE_SNAPSHOT, storage: { used_bytes: 1024, used_gib: 0, estimated_monthly_usd: 0 } };
    expect(evaluateAlerts(small, 1024 * 1024)).toEqual([]);
  });

  it('returns a storage alert at and above the threshold', () => {
    const alerts = evaluateAlerts(SAMPLE_SNAPSHOT, 50 * 1024 * 1024 * 1024);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ reason: 'storage_threshold' });
  });

  it('returns no ai_spend_threshold alert when spend is below threshold', () => {
    const snap: CostSnapshot = { ...SAMPLE_SNAPSHOT, ai_spend: { total_usd: 10 } };
    const alerts = evaluateAlerts(snap, 200 * 1024 * 1024 * 1024, 50);
    expect(alerts).toHaveLength(0);
  });

  it('returns ai_spend_threshold alert at and above the threshold', () => {
    const snap: CostSnapshot = { ...SAMPLE_SNAPSHOT, ai_spend: { total_usd: 50 } };
    const alerts = evaluateAlerts(snap, 200 * 1024 * 1024 * 1024, 50);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ reason: 'ai_spend_threshold', threshold_usd: 50, observed_usd: 50 });
  });

  it('can emit both storage and ai_spend_threshold alerts simultaneously', () => {
    const snap: CostSnapshot = { ...SAMPLE_SNAPSHOT, ai_spend: { total_usd: 75 } };
    const alerts = evaluateAlerts(snap, 50 * 1024 * 1024 * 1024, 50);
    expect(alerts).toHaveLength(2);
    const reasons = alerts.map((a) => a.reason);
    expect(reasons).toContain('storage_threshold');
    expect(reasons).toContain('ai_spend_threshold');
  });

  it('does not emit ai_spend_threshold when the threshold param is omitted', () => {
    const snap: CostSnapshot = { ...SAMPLE_SNAPSHOT, ai_spend: { total_usd: 999 } };
    const alerts = evaluateAlerts(snap, 200 * 1024 * 1024 * 1024);
    expect(alerts).toHaveLength(0);
  });
});

describe('todayKey', () => {
  it('produces a stable per-day UTC key', () => {
    expect(todayKey(new Date('2026-05-13T23:59:00Z'))).toBe('costs:alert:2026-05-13');
    expect(todayKey(new Date('2026-05-14T00:00:00Z'))).toBe('costs:alert:2026-05-14');
  });
});

describe('buildCostAlertProps', () => {
  it('flattens snapshot + storage alert into a primitive property bag', () => {
    const props = buildCostAlertProps(SAMPLE_SNAPSHOT, [
      { reason: 'storage_threshold', threshold_bytes: 50 * 1024 * 1024 * 1024, observed_bytes: SAMPLE_SNAPSHOT.storage.used_bytes },
    ]);
    expect(props).toMatchObject({
      storage_gib: '100.00',
      storage_usd_per_month: '1.50',
      threshold_gib: '50.00',
      alert_reasons: 'storage_threshold',
      ai_spend_usd: '0.0000',
      ai_spend_threshold_usd: '',
      videos_total: 42,
      users_total: 7,
      comments_total: 12,
    });
  });

  it('includes ai_spend fields when an ai_spend_threshold alert is present', () => {
    const snap: CostSnapshot = { ...SAMPLE_SNAPSHOT, ai_spend: { total_usd: 73.5 } };
    const props = buildCostAlertProps(snap, [
      { reason: 'ai_spend_threshold', threshold_usd: 50, observed_usd: 73.5 },
    ]);
    expect(props).toMatchObject({
      ai_spend_usd: '73.5000',
      ai_spend_threshold_usd: '50.00',
      threshold_gib: '',
      alert_reasons: 'ai_spend_threshold',
    });
  });
});

describe('getCostSnapshot', () => {
  it('aggregates D1 counters into a snapshot', async () => {
    const db = fakeDb([
      { used: 1024 * 1024 * 1024 }, // SUM(bytes) — 1 GiB
      { n: 10 }, // total videos
      { n: 2 }, // soft-deleted
      { n: 3 }, // 30d videos
      { n: 50 }, // total users
      { n: 4 }, // 30d users
      { n: 99 }, // comments
      { total: 1.23 }, // ai_costs SUM(est_usd)
    ]);
    const snap = await getCostSnapshot({ DB: db, CACHE: fakeKv() } as unknown as CostsEnv);
    expect(snap.storage.used_bytes).toBe(1024 * 1024 * 1024);
    expect(snap.storage.used_gib).toBeCloseTo(1, 6);
    expect(snap.storage.estimated_monthly_usd).toBeCloseTo(0.015, 6);
    expect(snap.ai_spend.total_usd).toBe(1.23);
    expect(snap.videos).toEqual({ total: 10, soft_deleted: 2, last_30d: 3 });
    expect(snap.users).toEqual({ total: 50, last_30d: 4 });
    expect(snap.comments).toEqual({ total: 99 });
  });

  it('treats null SUM/COUNT rows as zero', async () => {
    const db = fakeDb([
      { used: null },
      { n: null },
      { n: null },
      { n: null },
      { n: null },
      { n: null },
      { n: null },
      { total: null },
    ]);
    const snap = await getCostSnapshot({ DB: db, CACHE: fakeKv() } as unknown as CostsEnv);
    expect(snap.storage.used_bytes).toBe(0);
    expect(snap.ai_spend.total_usd).toBe(0);
    expect(snap.videos.total).toBe(0);
    expect(snap.users.total).toBe(0);
  });
});

describe('runCostMonitorSweep', () => {
  function dbForSnapshot(usedBytes: number, aiSpendUsd = 0): D1Database {
    return fakeDb([
      { used: usedBytes },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { total: aiSpendUsd },
    ]);
  }

  it('skips when storage is below threshold', async () => {
    const env: CostsEnv = {
      DB: dbForSnapshot(1024),
      CACHE: fakeKv(),
      ADMIN_EMAILS: 'ops@spooool.com',
    } as unknown as CostsEnv;
    const result = await runCostMonitorSweep(env);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no_alerts');
  });

  type SendMessage = {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  };
  function fakeEmailBinding() {
    const send = vi.fn(async (_msg: SendMessage) => ({ messageId: 'm-1' }));
    return { send };
  }

  it('skips when already sent today (KV marker present)', async () => {
    const binding = fakeEmailBinding();
    const env: CostsEnv = {
      DB: dbForSnapshot(200 * 1024 * 1024 * 1024),
      CACHE: fakeKv({ [todayKey()]: '1' }),
      ADMIN_EMAILS: 'ops@spooool.com',
      EMAIL: binding,
    } as unknown as CostsEnv;
    const result = await runCostMonitorSweep(env);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('already_sent_today');
    expect(binding.send).not.toHaveBeenCalled();
  });

  it('skips when no admin emails are configured', async () => {
    const env: CostsEnv = {
      DB: dbForSnapshot(200 * 1024 * 1024 * 1024),
      CACHE: fakeKv(),
      ADMIN_EMAILS: '',
      EMAIL: fakeEmailBinding(),
    } as unknown as CostsEnv;
    const result = await runCostMonitorSweep(env);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no_admin_emails');
  });

  it('sends a cost-alert email per admin and writes the dedup marker', async () => {
    const cache = fakeKv();
    const binding = fakeEmailBinding();
    const env: CostsEnv = {
      DB: dbForSnapshot(200 * 1024 * 1024 * 1024),
      CACHE: cache,
      ADMIN_EMAILS: 'a@x.com, b@x.com',
      EMAIL: binding,
    } as unknown as CostsEnv;
    const result = await runCostMonitorSweep(env);
    expect(result.sent).toBe(true);
    expect(result.reason).toBe('sent');
    expect(binding.send).toHaveBeenCalledTimes(2);
    const calls = binding.send.mock.calls.map((c) => c[0]);
    expect(calls[0].to).toBe('a@x.com');
    expect(calls[1].to).toBe('b@x.com');
    expect(calls[0].subject).toMatch(/Cost alert/);
    expect(calls[0].text).toContain('storage_threshold');
    expect(await cache.get(todayKey())).toBe('1');
  });

  it('emits ai_spend_threshold alert and sends email when AI spend exceeds threshold', async () => {
    const cache = fakeKv();
    const binding = fakeEmailBinding();
    const env: CostsEnv = {
      DB: dbForSnapshot(0, 75),           // storage below threshold, AI spend above $50
      CACHE: cache,
      ADMIN_EMAILS: 'ops@x.com',
      EMAIL: binding,
      COST_AI_SPEND_ALERT_USD: '50',
    } as unknown as CostsEnv;
    const result = await runCostMonitorSweep(env);
    expect(result.sent).toBe(true);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ reason: 'ai_spend_threshold', threshold_usd: 50 });
    const text = (binding.send.mock.calls[0][0] as { text: string }).text;
    expect(text).toContain('ai_spend_threshold');
  });
});
