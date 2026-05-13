import { describe, expect, it, vi } from 'vitest';
import {
  evaluateAlerts,
  getCostSnapshot,
  parseThresholdBytes,
  renderCostAlertEmail,
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
  videos: { total: 42, soft_deleted: 1, last_30d: 5 },
  users: { total: 7, last_30d: 2 },
  comments: { total: 12 },
};

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
});

describe('todayKey', () => {
  it('produces a stable per-day UTC key', () => {
    expect(todayKey(new Date('2026-05-13T23:59:00Z'))).toBe('costs:alert:2026-05-13');
    expect(todayKey(new Date('2026-05-14T00:00:00Z'))).toBe('costs:alert:2026-05-14');
  });
});

describe('renderCostAlertEmail', () => {
  it('mentions the observed storage and threshold reason', () => {
    const { subject, html } = renderCostAlertEmail(SAMPLE_SNAPSHOT, [
      { reason: 'storage_threshold', threshold_bytes: 50 * 1024 * 1024 * 1024, observed_bytes: SAMPLE_SNAPSHOT.storage.used_bytes },
    ]);
    expect(subject).toContain('100.00 GiB');
    expect(html).toContain('storage_threshold');
    expect(html).toContain('Videos: 42');
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
    ]);
    const snap = await getCostSnapshot({ DB: db, CACHE: fakeKv() } as unknown as CostsEnv);
    expect(snap.storage.used_bytes).toBe(1024 * 1024 * 1024);
    expect(snap.storage.used_gib).toBeCloseTo(1, 6);
    expect(snap.storage.estimated_monthly_usd).toBeCloseTo(0.015, 6);
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
    ]);
    const snap = await getCostSnapshot({ DB: db, CACHE: fakeKv() } as unknown as CostsEnv);
    expect(snap.storage.used_bytes).toBe(0);
    expect(snap.videos.total).toBe(0);
    expect(snap.users.total).toBe(0);
  });
});

describe('runCostMonitorSweep', () => {
  function dbForSnapshot(usedBytes: number): D1Database {
    return fakeDb([
      { used: usedBytes },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { n: 0 },
      { n: 0 },
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

  it('skips when already sent today (KV marker present)', async () => {
    const env: CostsEnv = {
      DB: dbForSnapshot(200 * 1024 * 1024 * 1024),
      CACHE: fakeKv({ [todayKey()]: '1' }),
      ADMIN_EMAILS: 'ops@spooool.com',
      RESEND_API_KEY: 'rk_test',
    } as unknown as CostsEnv;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    try {
      const result = await runCostMonitorSweep(env);
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('already_sent_today');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('skips when no admin emails are configured', async () => {
    const env: CostsEnv = {
      DB: dbForSnapshot(200 * 1024 * 1024 * 1024),
      CACHE: fakeKv(),
      ADMIN_EMAILS: '',
      RESEND_API_KEY: 'rk_test',
    } as unknown as CostsEnv;
    const result = await runCostMonitorSweep(env);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no_admin_emails');
  });

  it('sends an email per admin and writes the dedup marker', async () => {
    const cache = fakeKv();
    const env: CostsEnv = {
      DB: dbForSnapshot(200 * 1024 * 1024 * 1024),
      CACHE: cache,
      ADMIN_EMAILS: 'a@x.com, b@x.com',
      RESEND_API_KEY: 'rk_test',
    } as unknown as CostsEnv;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    try {
      const result = await runCostMonitorSweep(env);
      expect(result.sent).toBe(true);
      expect(result.reason).toBe('sent');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await cache.get(todayKey())).toBe('1');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
