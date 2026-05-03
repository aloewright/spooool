import { describe, expect, it, vi } from 'vitest';
import {
  buildHealthReport,
  checkCache,
  checkDatabase,
  checkStorage,
  healthRoutes,
  resolveVersion,
  type HealthEnv,
} from './health';

function fakeDB(impl: { first: () => Promise<unknown> }): D1Database {
  return {
    prepare: () => ({ first: impl.first }) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
}

function fakeKV(impl: { get: (key: string) => Promise<string | null> }): KVNamespace {
  return { get: impl.get } as unknown as KVNamespace;
}

function fakeBucket(impl: { head: (key: string) => Promise<unknown> }): R2Bucket {
  return { head: impl.head } as unknown as R2Bucket;
}

describe('checkDatabase', () => {
  it('returns skip when no DB binding is configured', async () => {
    expect(await checkDatabase(undefined)).toEqual({ status: 'skip' });
  });

  it('returns ok with latency when SELECT 1 succeeds', async () => {
    const db = fakeDB({ first: async () => ({ ok: 1 }) });
    const result = await checkDatabase(db);
    expect(result.status).toBe('ok');
    expect(typeof result.latency_ms).toBe('number');
  });

  it('returns fail with the error message when the query throws', async () => {
    const db = fakeDB({
      first: async () => {
        throw new Error('connection lost');
      },
    });
    const result = await checkDatabase(db);
    expect(result.status).toBe('fail');
    expect(result.error).toBe('connection lost');
  });
});

describe('checkCache', () => {
  it('returns skip without a binding', async () => {
    expect(await checkCache(undefined)).toEqual({ status: 'skip' });
  });

  it('returns ok when the KV namespace responds (even with null value)', async () => {
    const kv = fakeKV({ get: async () => null });
    const result = await checkCache(kv);
    expect(result.status).toBe('ok');
  });

  it('returns fail when KV throws', async () => {
    const kv = fakeKV({
      get: async () => {
        throw new Error('kv down');
      },
    });
    expect((await checkCache(kv)).status).toBe('fail');
  });
});

describe('checkStorage', () => {
  it('returns skip without a binding', async () => {
    expect(await checkStorage(undefined)).toEqual({ status: 'skip' });
  });

  it('treats a null response from R2 head as ok (object simply absent)', async () => {
    const bucket = fakeBucket({ head: async () => null });
    expect((await checkStorage(bucket)).status).toBe('ok');
  });

  it('returns fail when R2 throws', async () => {
    const bucket = fakeBucket({
      head: async () => {
        throw new Error('r2 down');
      },
    });
    expect((await checkStorage(bucket)).status).toBe('fail');
  });
});

describe('resolveVersion', () => {
  it('prefers Cloudflare CF_VERSION_METADATA.id when available', () => {
    expect(resolveVersion({ CF_VERSION_METADATA: { id: 'abc123' }, WORKER_VERSION: 'fallback' })).toBe('abc123');
  });

  it('falls back to WORKER_VERSION env var', () => {
    expect(resolveVersion({ WORKER_VERSION: 'v1.2.3' })).toBe('v1.2.3');
  });

  it('returns null when neither is set', () => {
    expect(resolveVersion({})).toBeNull();
  });
});

describe('buildHealthReport', () => {
  it('reports ok when every probe passes', async () => {
    const env: HealthEnv = {
      DB: fakeDB({ first: async () => ({ ok: 1 }) }),
      CACHE: fakeKV({ get: async () => null }),
      VIDEOS: fakeBucket({ head: async () => null }),
      WORKER_VERSION: 'test-1',
    };
    const now = Date.now();
    const report = await buildHealthReport(env, now);
    expect(report.status).toBe('ok');
    expect(report.version).toBe('test-1');
    expect(report.checks.db.status).toBe('ok');
    expect(report.checks.cache.status).toBe('ok');
    expect(report.checks.storage.status).toBe('ok');
    expect(report.timestamp).toBe(new Date(now).toISOString());
    expect(report.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded when any single dependency fails', async () => {
    const env: HealthEnv = {
      DB: fakeDB({
        first: async () => {
          throw new Error('db down');
        },
      }),
      CACHE: fakeKV({ get: async () => null }),
      VIDEOS: fakeBucket({ head: async () => null }),
    };
    const report = await buildHealthReport(env);
    expect(report.status).toBe('degraded');
    expect(report.checks.db.status).toBe('fail');
    expect(report.checks.db.error).toBe('db down');
  });

  it('skipped probes do not flip the report to degraded', async () => {
    const report = await buildHealthReport({});
    expect(report.status).toBe('ok');
    expect(report.checks.db.status).toBe('skip');
    expect(report.checks.cache.status).toBe('skip');
    expect(report.checks.storage.status).toBe('skip');
  });
});

describe('healthRoutes', () => {
  it('serves a 200 JSON body with no-store cache when healthy', async () => {
    const env: HealthEnv = {
      DB: fakeDB({ first: async () => ({ ok: 1 }) }),
      CACHE: fakeKV({ get: async () => null }),
      VIDEOS: fakeBucket({ head: async () => null }),
    };
    const res = await healthRoutes.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('serves a 503 when a dependency is failing', async () => {
    const env: HealthEnv = {
      DB: fakeDB({
        first: async () => {
          throw new Error('boom');
        },
      }),
    };
    const res = await healthRoutes.request('/api/health', {}, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded');
  });

  it('runs all three probes concurrently rather than sequentially', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const slowProbe = async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return null;
    };
    const env: HealthEnv = {
      DB: fakeDB({ first: slowProbe }),
      CACHE: fakeKV({ get: slowProbe }),
      VIDEOS: fakeBucket({ head: slowProbe }),
    };
    await buildHealthReport(env);
    expect(maxConcurrent).toBe(3);
    vi.restoreAllMocks();
  });
});
