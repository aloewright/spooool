// ALO-182: public status page backend.
//
// Returns aggregated current health (delegating to buildHealthReport) plus
// curated incident history and planned maintenance. Incidents/maintenance
// live in this file as code-reviewed constants — there is no admin UI yet,
// and a static list is honest about what we can actually keep accurate.

import { Hono } from 'hono';
import { buildHealthReport, type HealthEnv, type HealthReport } from './health';

export interface Incident {
  id: string;
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  severity: 'minor' | 'major' | 'critical';
  summary: string;
}

export interface Maintenance {
  id: string;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  summary: string;
}

export const INCIDENTS: readonly Incident[] = [];

export const MAINTENANCE: readonly Maintenance[] = [];

export interface StatusReport {
  health: HealthReport;
  incidents: readonly Incident[];
  maintenance: readonly Maintenance[];
}

export async function buildStatusReport(env: HealthEnv, now: number = Date.now()): Promise<StatusReport> {
  const health = await buildHealthReport(env, now);
  return { health, incidents: INCIDENTS, maintenance: MAINTENANCE };
}

export const statusRoutes = new Hono<{ Bindings: HealthEnv }>();

statusRoutes.get('/api/status', async (c) => {
  const report = await buildStatusReport(c.env);
  return new Response(JSON.stringify(report), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Allow a short edge cache so the page can survive a brief origin blip
      // and still report something useful — but keep it short enough that a
      // real outage shows up within a minute.
      'Cache-Control': 'public, max-age=30',
    },
  });
});
