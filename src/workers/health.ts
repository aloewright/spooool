import { Hono } from 'hono';

export interface HealthEnv {
  DB?: D1Database;
  CACHE?: KVNamespace;
  VIDEOS?: R2Bucket;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  WORKER_VERSION?: string;
}

type CheckStatus = 'ok' | 'fail' | 'skip';

export interface HealthCheck {
  status: CheckStatus;
  latency_ms?: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptime_ms: number;
  version: string | null;
  timestamp: string;
  checks: {
    db: HealthCheck;
    cache: HealthCheck;
    storage: HealthCheck;
  };
}

const startedAt = Date.now();

async function timed<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: string; latency_ms: number }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, latency_ms: Date.now() - t0 };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - t0,
    };
  }
}

export async function checkDatabase(db: D1Database | undefined): Promise<HealthCheck> {
  if (!db) return { status: 'skip' };
  const { error, latency_ms } = await timed(() => db.prepare('SELECT 1 AS ok').first());
  return error ? { status: 'fail', latency_ms, error } : { status: 'ok', latency_ms };
}

export async function checkCache(cache: KVNamespace | undefined): Promise<HealthCheck> {
  if (!cache) return { status: 'skip' };
  const { error, latency_ms } = await timed(() => cache.get('health:probe'));
  return error ? { status: 'fail', latency_ms, error } : { status: 'ok', latency_ms };
}

export async function checkStorage(bucket: R2Bucket | undefined): Promise<HealthCheck> {
  if (!bucket) return { status: 'skip' };
  const { error, latency_ms } = await timed(() => bucket.head('__health_probe__'));
  return error ? { status: 'fail', latency_ms, error } : { status: 'ok', latency_ms };
}

export function resolveVersion(env: HealthEnv): string | null {
  return env.CF_VERSION_METADATA?.id ?? env.WORKER_VERSION ?? null;
}

export async function buildHealthReport(env: HealthEnv, now: number = Date.now()): Promise<HealthReport> {
  const [db, cache, storage] = await Promise.all([
    checkDatabase(env.DB),
    checkCache(env.CACHE),
    checkStorage(env.VIDEOS),
  ]);
  const status: HealthReport['status'] =
    db.status === 'fail' || cache.status === 'fail' || storage.status === 'fail'
      ? 'degraded'
      : 'ok';
  return {
    status,
    uptime_ms: now - startedAt,
    version: resolveVersion(env),
    timestamp: new Date(now).toISOString(),
    checks: { db, cache, storage },
  };
}

export const healthRoutes = new Hono<{ Bindings: HealthEnv }>();

healthRoutes.get('/api/health', async (c) => {
  const report = await buildHealthReport(c.env);
  const httpStatus = report.status === 'ok' ? 200 : 503;
  return new Response(JSON.stringify(report), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
});
