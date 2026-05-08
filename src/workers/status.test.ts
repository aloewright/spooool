import { describe, expect, it } from 'vitest';
import { buildStatusReport, statusRoutes, type Incident, type Maintenance } from './status';
import type { HealthEnv } from './health';

function fakeDB(): D1Database {
  return {
    prepare: () => ({ first: async () => ({ ok: 1 }) }) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
}

describe('buildStatusReport', () => {
  it('embeds the health report alongside incidents and maintenance', async () => {
    const env: HealthEnv = { DB: fakeDB() };
    const report = await buildStatusReport(env);
    expect(report.health.status).toBeDefined();
    expect(Array.isArray(report.incidents)).toBe(true);
    expect(Array.isArray(report.maintenance)).toBe(true);
  });
});

describe('statusRoutes', () => {
  it('serves /api/status as JSON with a short cache window', async () => {
    const res = await statusRoutes.request('/api/status', {}, {} satisfies HealthEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    const body = (await res.json()) as {
      health: { status: string };
      incidents: Incident[];
      maintenance: Maintenance[];
    };
    expect(body.health.status).toBe('ok');
    expect(Array.isArray(body.incidents)).toBe(true);
    expect(Array.isArray(body.maintenance)).toBe(true);
  });
});
