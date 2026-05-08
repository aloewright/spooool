import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  buildStatusReport,
  deriveOverallStatus,
  statusRoutes,
  type PublicIncident,
  type StatusEnv,
} from './status';
import type { HealthReport } from './health';

interface FakeStore {
  incidents: Map<
    string,
    {
      id: string;
      title: string;
      component: string;
      status: string;
      severity: string;
      started_at: string;
      resolved_at: string | null;
      created_at: string;
      updated_at: string;
    }
  >;
  incidentUpdates: Array<{
    id: string;
    incident_id: string;
    status: string;
    message: string;
    created_at: string;
  }>;
  maintenance: Map<
    string,
    {
      id: string;
      title: string;
      description: string;
      starts_at: string;
      ends_at: string;
      created_at: string;
    }
  >;
  userRoles: Map<string, string[]>;
}

function makeStore(): FakeStore {
  return {
    incidents: new Map(),
    incidentUpdates: [],
    maintenance: new Map(),
    userRoles: new Map(),
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function fakeDB(store: FakeStore): D1Database {
  const stmt = (sql: string): PreparedStmt => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api: PreparedStmt = {
      bind(...v) {
        bound = v;
        return api;
      },
      async first<T>() {
        if (trimmed.startsWith('SELECT 1 AS ok')) {
          return { ok: 1 } as unknown as T;
        }
        if (trimmed.startsWith("SELECT 1 FROM user_roles WHERE role = 'admin' LIMIT 1")) {
          for (const roles of store.userRoles.values()) {
            if (roles.includes('admin')) return { '1': 1 } as unknown as T;
          }
          return null;
        }
        if (trimmed.startsWith('SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?')) {
          const uid = bound[0] as string;
          const role = bound[1] as string;
          return store.userRoles.get(uid)?.includes(role) ? ({ '1': 1 } as unknown as T) : null;
        }
        if (trimmed.startsWith('SELECT id FROM incidents WHERE id = ?')) {
          const inc = store.incidents.get(bound[0] as string);
          return (inc ? { id: inc.id } : null) as T | null;
        }
        return null;
      },
      async all<T>() {
        if (trimmed.startsWith('SELECT id, title, component, status, severity')) {
          const cutoff = bound[0] as string;
          const filtered = [...store.incidents.values()]
            .filter((i) => i.status !== 'resolved' || i.started_at >= cutoff)
            .sort((a, b) => (a.started_at > b.started_at ? -1 : 1));
          return { results: filtered as unknown as T[] };
        }
        if (trimmed.startsWith('SELECT id, incident_id, status, message, created_at')) {
          const ids = bound as string[];
          const filtered = store.incidentUpdates
            .filter((u) => ids.includes(u.incident_id))
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
          return { results: filtered as unknown as T[] };
        }
        if (trimmed.startsWith('SELECT id, title, description, starts_at, ends_at, created_at')) {
          const lookback = bound[0] as string;
          const lookahead = bound[1] as string;
          const filtered = [...store.maintenance.values()]
            .filter((m) => m.ends_at >= lookback && m.starts_at <= lookahead)
            .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
          return { results: filtered as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (trimmed.startsWith('INSERT INTO incidents')) {
          const id = bound[0] as string;
          store.incidents.set(id, {
            id,
            title: bound[1] as string,
            component: bound[2] as string,
            status: bound[3] as string,
            severity: bound[4] as string,
            started_at: bound[5] as string,
            resolved_at: bound[6] as string | null,
            created_at: bound[8] as string,
            updated_at: bound[9] as string,
          });
        } else if (trimmed.startsWith('INSERT INTO incident_updates')) {
          store.incidentUpdates.push({
            id: bound[0] as string,
            incident_id: bound[1] as string,
            status: bound[2] as string,
            message: bound[3] as string,
            created_at: bound[5] as string,
          });
        } else if (trimmed.startsWith('INSERT INTO maintenance_windows')) {
          const id = bound[0] as string;
          store.maintenance.set(id, {
            id,
            title: bound[1] as string,
            description: bound[2] as string,
            starts_at: bound[3] as string,
            ends_at: bound[4] as string,
            created_at: bound[6] as string,
          });
        } else if (trimmed.startsWith('UPDATE incidents')) {
          const inc = store.incidents.get(bound[3] as string);
          if (inc) {
            inc.status = bound[0] as string;
            const incomingResolved = bound[1] as string | null;
            inc.resolved_at = incomingResolved ?? inc.resolved_at;
            inc.updated_at = bound[2] as string;
          }
        }
        return { success: true };
      },
    };
    return api;
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: PreparedStmt[]) => {
      for (const s of statements) {
        await s.run();
      }
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

function fakeKV(): KVNamespace {
  return { get: async () => null } as unknown as KVNamespace;
}

function fakeBucket(): R2Bucket {
  return { head: async () => null } as unknown as R2Bucket;
}

function envFor(store: FakeStore): StatusEnv {
  return {
    DB: fakeDB(store),
    CACHE: fakeKV(),
    VIDEOS: fakeBucket(),
  } as StatusEnv;
}

function healthOk(): HealthReport {
  return {
    status: 'ok',
    uptime_ms: 0,
    version: null,
    timestamp: new Date().toISOString(),
    checks: {
      db: { status: 'ok', latency_ms: 1 },
      cache: { status: 'ok', latency_ms: 1 },
      storage: { status: 'ok', latency_ms: 1 },
    },
  };
}

function healthDegraded(): HealthReport {
  return {
    ...healthOk(),
    status: 'degraded',
    checks: {
      ...healthOk().checks,
      db: { status: 'fail', latency_ms: 5, error: 'down' },
    },
  };
}

function incident(
  id: string,
  status: PublicIncident['status'],
  severity: PublicIncident['severity'],
): PublicIncident {
  return {
    id,
    title: 't',
    component: 'platform',
    status,
    severity,
    started_at: new Date().toISOString(),
    resolved_at: null,
    updated_at: new Date().toISOString(),
    updates: [],
  };
}

describe('deriveOverallStatus', () => {
  it('returns operational when no incidents and health ok', () => {
    expect(deriveOverallStatus(healthOk(), [], false)).toBe('operational');
  });

  it('returns major_outage when an active incident is critical', () => {
    expect(
      deriveOverallStatus(healthOk(), [incident('a', 'investigating', 'critical')], false),
    ).toBe('major_outage');
  });

  it('returns major_outage when an active incident is major', () => {
    expect(
      deriveOverallStatus(healthOk(), [incident('a', 'monitoring', 'major')], false),
    ).toBe('major_outage');
  });

  it('returns degraded when probes fail even with no incidents', () => {
    expect(deriveOverallStatus(healthDegraded(), [], false)).toBe('degraded');
  });

  it('returns degraded for a minor active incident', () => {
    expect(
      deriveOverallStatus(healthOk(), [incident('a', 'identified', 'minor')], false),
    ).toBe('degraded');
  });

  it('returns maintenance when in window and no incidents', () => {
    expect(deriveOverallStatus(healthOk(), [], true)).toBe('maintenance');
  });

  it('prefers incident severity over maintenance label', () => {
    expect(
      deriveOverallStatus(healthOk(), [incident('a', 'investigating', 'minor')], true),
    ).toBe('degraded');
  });
});

describe('buildStatusReport', () => {
  it('returns an empty report when no incidents or maintenance exist', async () => {
    const env = envFor(makeStore());
    const report = await buildStatusReport(env);
    expect(report.overall).toBe('operational');
    expect(report.active_incidents).toEqual([]);
    expect(report.recent_incidents).toEqual([]);
    expect(report.upcoming_maintenance).toEqual([]);
    expect(report.recent_maintenance).toEqual([]);
    expect(report.health.status).toBe('ok');
    expect(report.generated_at).toMatch(/T.*Z$/);
  });

  it('separates active vs resolved incidents and attaches their updates', async () => {
    const store = makeStore();
    const now = Date.now();
    store.incidents.set('inc1', {
      id: 'inc1',
      title: 'API blip',
      component: 'API',
      status: 'investigating',
      severity: 'minor',
      started_at: new Date(now - 60_000).toISOString(),
      resolved_at: null,
      created_at: new Date(now - 60_000).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    store.incidents.set('inc2', {
      id: 'inc2',
      title: 'Past CDN issue',
      component: 'CDN',
      status: 'resolved',
      severity: 'minor',
      started_at: new Date(now - 86_400_000).toISOString(),
      resolved_at: new Date(now - 80_000_000).toISOString(),
      created_at: new Date(now - 86_400_000).toISOString(),
      updated_at: new Date(now - 80_000_000).toISOString(),
    });
    store.incidentUpdates.push({
      id: 'u1',
      incident_id: 'inc1',
      status: 'investigating',
      message: 'looking',
      created_at: new Date(now - 30_000).toISOString(),
    });

    const report = await buildStatusReport(envFor(store), now);
    expect(report.active_incidents.map((i) => i.id)).toEqual(['inc1']);
    expect(report.recent_incidents.map((i) => i.id)).toEqual(['inc2']);
    expect(report.active_incidents[0].updates).toHaveLength(1);
    expect(report.active_incidents[0].updates[0].message).toBe('looking');
    expect(report.overall).toBe('degraded');
  });

  it('marks status as maintenance only when current time is inside a window', async () => {
    const store = makeStore();
    const now = Date.now();
    store.maintenance.set('m1', {
      id: 'm1',
      title: 'DB upgrade',
      description: 'Read-only for 10 minutes',
      starts_at: new Date(now - 5 * 60_000).toISOString(),
      ends_at: new Date(now + 5 * 60_000).toISOString(),
      created_at: new Date(now).toISOString(),
    });
    const report = await buildStatusReport(envFor(store), now);
    expect(report.upcoming_maintenance).toHaveLength(1);
    expect(report.overall).toBe('maintenance');
  });

  it('puts past maintenance into recent_maintenance', async () => {
    const store = makeStore();
    const now = Date.now();
    store.maintenance.set('m_past', {
      id: 'm_past',
      title: 'Old DB upgrade',
      description: '',
      starts_at: new Date(now - 2 * 86_400_000).toISOString(),
      ends_at: new Date(now - 86_400_000).toISOString(),
      created_at: new Date(now - 2 * 86_400_000).toISOString(),
    });
    const report = await buildStatusReport(envFor(store), now);
    expect(report.upcoming_maintenance).toHaveLength(0);
    expect(report.recent_maintenance.map((m) => m.id)).toEqual(['m_past']);
    expect(report.overall).toBe('operational');
  });
});

describe('GET /api/status', () => {
  it('serves a 200 JSON body with public cache hint', async () => {
    const env = envFor(makeStore());
    const res = await statusRoutes.request('/api/status', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('public');
    const body = (await res.json()) as { overall: string };
    expect(body.overall).toBe('operational');
  });
});

type Ctx = { Variables: { user: { id: string; email: string; name: string } | null } };

function appAs(store: FakeStore, user: { id: string; email: string } | null) {
  const app = new Hono<Ctx>();
  app.use('*', async (c, next) => {
    c.set('user', user ? { id: user.id, email: user.email, name: 'x' } : null);
    await next();
  });
  app.route('/', statusRoutes);
  const env = {
    ...envFor(store),
    ADMIN_EMAILS: 'admin@example.com',
  } as StatusEnv;
  return {
    async post(path: string, body?: unknown) {
      return app.fetch(
        new Request(`http://t${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        }),
        env,
      );
    },
  };
}

describe('admin write endpoints', () => {
  it('rejects unauthenticated callers with 403', async () => {
    const store = makeStore();
    const client = appAs(store, null);
    const res = await client.post('/api/admin/status/incidents', {
      title: 'Outage',
      message: 'investigating',
    });
    expect(res.status).toBe(403);
  });

  it('rejects authenticated non-admins with 403', async () => {
    const store = makeStore();
    const client = appAs(store, { id: 'u1', email: 'mortal@example.com' });
    const res = await client.post('/api/admin/status/incidents', {
      title: 'Outage',
      message: 'investigating',
    });
    expect(res.status).toBe(403);
  });

  it('lets a bootstrap admin create an incident with an initial update', async () => {
    const store = makeStore();
    const client = appAs(store, { id: 'admin1', email: 'admin@example.com' });
    const res = await client.post('/api/admin/status/incidents', {
      title: 'Search slowdown',
      component: 'Search',
      status: 'investigating',
      severity: 'minor',
      message: 'We are looking into elevated latency on /search.',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('investigating');
    const inserted = store.incidents.get(body.id);
    expect(inserted?.title).toBe('Search slowdown');
    expect(store.incidentUpdates).toHaveLength(1);
    expect(store.incidentUpdates[0].incident_id).toBe(body.id);
  });

  it('lets an admin post follow-up updates and resolve an incident', async () => {
    const store = makeStore();
    const client = appAs(store, { id: 'admin1', email: 'admin@example.com' });
    const created = await client.post('/api/admin/status/incidents', {
      title: 'API errors',
      message: 'investigating',
    });
    const { id } = (await created.json()) as { id: string };

    const update = await client.post(`/api/admin/status/incidents/${id}/updates`, {
      status: 'resolved',
      message: 'Service restored.',
    });
    expect(update.status).toBe(201);
    const inc = store.incidents.get(id);
    expect(inc?.status).toBe('resolved');
    expect(inc?.resolved_at).not.toBeNull();
  });

  it('returns 404 when posting an update to a missing incident', async () => {
    const store = makeStore();
    const client = appAs(store, { id: 'admin1', email: 'admin@example.com' });
    const res = await client.post('/api/admin/status/incidents/missing/updates', {
      status: 'monitoring',
      message: 'still here',
    });
    expect(res.status).toBe(404);
  });

  it('rejects maintenance windows with end <= start', async () => {
    const store = makeStore();
    const client = appAs(store, { id: 'admin1', email: 'admin@example.com' });
    const res = await client.post('/api/admin/status/maintenance', {
      title: 'Bad window',
      description: '',
      starts_at: '2030-01-01T10:00:00Z',
      ends_at: '2030-01-01T09:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  it('persists a valid maintenance window', async () => {
    const store = makeStore();
    const client = appAs(store, { id: 'admin1', email: 'admin@example.com' });
    const res = await client.post('/api/admin/status/maintenance', {
      title: 'Planned reboot',
      description: 'Cycling worker fleet',
      starts_at: '2030-01-01T10:00:00Z',
      ends_at: '2030-01-01T11:00:00Z',
    });
    expect(res.status).toBe(201);
    expect(store.maintenance.size).toBe(1);
  });
});

describe('migration 0019 file', () => {
  it('declares the incidents and maintenance tables', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sql = fs.readFileSync(
      path.join(here, '..', 'db', 'migrations', '0019_status_page.sql'),
      'utf8',
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS incidents/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS incident_updates/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS maintenance_windows/);
  });
});
