// ALO-182: public status page (status.spooool.com).
//
// Surfaces three things over a single GET /api/status payload:
//   1. Current health snapshot — derived live from the same probes that
//      back /api/health (db / cache / storage). The page exposes the
//      coarse "operational | degraded | down" overall status; consumers
//      that want the detail can call /api/health directly.
//   2. Active + recent incidents (with their update timeline).
//   3. Upcoming + recent planned maintenance windows.
//
// Admin POST endpoints let an operator open/update incidents and post
// maintenance windows without touching the DB by hand. Reads are public
// and aggressively-cached friendly (Cache-Control: public, s-maxage=30).

import { Hono } from 'hono';
import { z } from 'zod';
import { buildHealthReport, type HealthEnv, type HealthReport } from './health';
import { isAdmin, type RolesEnv } from './roles';

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

// How far back the public history goes. 90 days mirrors typical SaaS
// status pages and keeps the SQL bounded even on a noisy week.
export const INCIDENT_HISTORY_DAYS = 90;

// Window around "now" for surfacing maintenance: anything ending in the
// past 7 days or scheduled within the next 60 days is visible.
export const MAINTENANCE_LOOKBACK_DAYS = 7;
export const MAINTENANCE_LOOKAHEAD_DAYS = 60;

export interface StatusEnv extends HealthEnv, RolesEnv {
  DB: D1Database;
}

type SessionUser = { id: string; email: string; name: string } | null;
type StatusVariables = { user: SessionUser };

interface IncidentRow {
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

interface IncidentUpdateRow {
  id: string;
  incident_id: string;
  status: string;
  message: string;
  created_at: string;
}

interface MaintenanceRow {
  id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

export type OverallStatus = 'operational' | 'degraded' | 'major_outage' | 'maintenance';

export interface StatusReport {
  overall: OverallStatus;
  generated_at: string;
  health: HealthReport;
  active_incidents: PublicIncident[];
  recent_incidents: PublicIncident[];
  upcoming_maintenance: PublicMaintenance[];
  recent_maintenance: PublicMaintenance[];
}

export interface PublicIncident {
  id: string;
  title: string;
  component: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  started_at: string;
  resolved_at: string | null;
  updated_at: string;
  updates: PublicIncidentUpdate[];
}

export interface PublicIncidentUpdate {
  id: string;
  status: IncidentStatus;
  message: string;
  created_at: string;
}

export interface PublicMaintenance {
  id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
}

function asIncidentStatus(value: string): IncidentStatus {
  return (INCIDENT_STATUSES as readonly string[]).includes(value)
    ? (value as IncidentStatus)
    : 'investigating';
}

function asIncidentSeverity(value: string): IncidentSeverity {
  return (INCIDENT_SEVERITIES as readonly string[]).includes(value)
    ? (value as IncidentSeverity)
    : 'minor';
}

// Roll the active-incident list + health snapshot up into one of four
// public-facing labels. Maintenance overrides "operational" only when
// there is no incident in flight.
export function deriveOverallStatus(
  health: HealthReport,
  activeIncidents: PublicIncident[],
  inMaintenance: boolean,
): OverallStatus {
  const critical = activeIncidents.find((i) => i.severity === 'critical');
  if (critical) return 'major_outage';
  if (activeIncidents.some((i) => i.severity === 'major')) return 'major_outage';
  if (health.status === 'degraded') return 'degraded';
  if (activeIncidents.length > 0) return 'degraded';
  if (inMaintenance) return 'maintenance';
  return 'operational';
}

async function loadIncidents(db: D1Database, now: number): Promise<{
  active: PublicIncident[];
  recent: PublicIncident[];
}> {
  const cutoffMs = now - INCIDENT_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // SQLite compares TEXT timestamps lexicographically; ISO-8601 keeps
  // that stable, but historical rows inserted via DEFAULT CURRENT_TIMESTAMP
  // use the SQLite "YYYY-MM-DD HH:MM:SS" form. Both still sort correctly,
  // and Date.parse handles the space-separated variant.
  const { results: incidentRows } = await db
    .prepare(
      `SELECT id, title, component, status, severity, started_at,
              resolved_at, created_at, updated_at
         FROM incidents
        WHERE status != 'resolved' OR started_at >= ?
        ORDER BY started_at DESC
        LIMIT 100`,
    )
    .bind(cutoffIso)
    .all<IncidentRow>();

  const incidents = incidentRows ?? [];
  if (incidents.length === 0) {
    return { active: [], recent: [] };
  }

  const ids = incidents.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: updateRows } = await db
    .prepare(
      `SELECT id, incident_id, status, message, created_at
         FROM incident_updates
        WHERE incident_id IN (${placeholders})
        ORDER BY created_at ASC`,
    )
    .bind(...ids)
    .all<IncidentUpdateRow>();

  const updatesByIncident = new Map<string, PublicIncidentUpdate[]>();
  for (const u of updateRows ?? []) {
    const list = updatesByIncident.get(u.incident_id) ?? [];
    list.push({
      id: u.id,
      status: asIncidentStatus(u.status),
      message: u.message,
      created_at: u.created_at,
    });
    updatesByIncident.set(u.incident_id, list);
  }

  const mapped: PublicIncident[] = incidents.map((row) => ({
    id: row.id,
    title: row.title,
    component: row.component,
    status: asIncidentStatus(row.status),
    severity: asIncidentSeverity(row.severity),
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,
    updates: updatesByIncident.get(row.id) ?? [],
  }));

  return {
    active: mapped.filter((i) => i.status !== 'resolved'),
    recent: mapped.filter((i) => i.status === 'resolved'),
  };
}

async function loadMaintenance(db: D1Database, now: number): Promise<{
  upcoming: PublicMaintenance[];
  recent: PublicMaintenance[];
  inWindow: boolean;
}> {
  const lookbackIso = new Date(now - MAINTENANCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const lookaheadIso = new Date(now + MAINTENANCE_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, title, description, starts_at, ends_at, created_at
         FROM maintenance_windows
        WHERE ends_at >= ? AND starts_at <= ?
        ORDER BY starts_at ASC
        LIMIT 50`,
    )
    .bind(lookbackIso, lookaheadIso)
    .all<MaintenanceRow>();

  const upcoming: PublicMaintenance[] = [];
  const recent: PublicMaintenance[] = [];
  let inWindow = false;
  for (const row of results ?? []) {
    const startMs = Date.parse(row.starts_at);
    const endMs = Date.parse(row.ends_at);
    const item: PublicMaintenance = {
      id: row.id,
      title: row.title,
      description: row.description,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
    };
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && now >= startMs && now <= endMs) {
      inWindow = true;
      upcoming.push(item);
      continue;
    }
    if (Number.isFinite(endMs) && endMs < now) {
      recent.push(item);
    } else {
      upcoming.push(item);
    }
  }
  return { upcoming, recent, inWindow };
}

export async function buildStatusReport(env: StatusEnv, now: number = Date.now()): Promise<StatusReport> {
  const [health, incidents, maintenance] = await Promise.all([
    buildHealthReport(env, now),
    loadIncidents(env.DB, now),
    loadMaintenance(env.DB, now),
  ]);
  const overall = deriveOverallStatus(health, incidents.active, maintenance.inWindow);
  return {
    overall,
    generated_at: new Date(now).toISOString(),
    health,
    active_incidents: incidents.active,
    recent_incidents: incidents.recent,
    upcoming_maintenance: maintenance.upcoming,
    recent_maintenance: maintenance.recent,
  };
}

const incidentCreateSchema = z.object({
  title: z.string().min(1).max(200),
  component: z.string().min(1).max(80).default('platform'),
  status: z.enum(INCIDENT_STATUSES).default('investigating'),
  severity: z.enum(INCIDENT_SEVERITIES).default('minor'),
  message: z.string().min(1).max(4000),
});

const incidentUpdateSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  message: z.string().min(1).max(4000),
});

const maintenanceSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
});

function newId(prefix: string): string {
  // crypto.randomUUID is available in Workers + the test runtime; falling
  // back to Math.random keeps the unit tests stable when crypto is absent.
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${uuid}`;
}

export const statusRoutes = new Hono<{
  Bindings: StatusEnv;
  Variables: StatusVariables;
}>();

statusRoutes.get('/api/status', async (c) => {
  const report = await buildStatusReport(c.env);
  // Public liveness data — always 200 with the report inside. Crawlers
  // and uptime monitors can poll this without auth.
  return new Response(JSON.stringify(report), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short edge-cached window so the page feels live but a stampede
      // of clients doesn't repeatedly hit D1.
      'Cache-Control': 'public, max-age=10, s-maxage=30',
    },
  });
});

statusRoutes.use('/api/admin/status/*', async (c, next) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});

statusRoutes.post('/api/admin/status/incidents', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const json = await c.req.json().catch(() => null);
  const parsed = incidentCreateSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid incident', details: parsed.error.flatten() }, 400);
  }
  const { title, component, status, severity, message } = parsed.data;
  const incidentId = newId('inc');
  const updateId = newId('iup');
  const nowIso = new Date().toISOString();
  const resolvedAt = status === 'resolved' ? nowIso : null;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO incidents
         (id, title, component, status, severity, started_at, resolved_at,
          created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(incidentId, title, component, status, severity, nowIso, resolvedAt, user.id, nowIso, nowIso),
    c.env.DB.prepare(
      `INSERT INTO incident_updates
         (id, incident_id, status, message, posted_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(updateId, incidentId, status, message, user.id, nowIso),
  ]);
  return c.json({ id: incidentId, status, severity }, 201);
});

statusRoutes.post('/api/admin/status/incidents/:id/updates', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const incidentId = c.req.param('id');
  const json = await c.req.json().catch(() => null);
  const parsed = incidentUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid update', details: parsed.error.flatten() }, 400);
  }
  const existing = await c.env.DB.prepare('SELECT id FROM incidents WHERE id = ?')
    .bind(incidentId)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: 'Incident not found' }, 404);

  const { status, message } = parsed.data;
  const updateId = newId('iup');
  const nowIso = new Date().toISOString();
  const resolvedAt = status === 'resolved' ? nowIso : null;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO incident_updates
         (id, incident_id, status, message, posted_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(updateId, incidentId, status, message, user.id, nowIso),
    c.env.DB.prepare(
      `UPDATE incidents
          SET status = ?,
              resolved_at = COALESCE(?, resolved_at),
              updated_at = ?
        WHERE id = ?`,
    ).bind(status, resolvedAt, nowIso, incidentId),
  ]);
  return c.json({ id: updateId, incident_id: incidentId, status }, 201);
});

statusRoutes.post('/api/admin/status/maintenance', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const json = await c.req.json().catch(() => null);
  const parsed = maintenanceSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid maintenance window', details: parsed.error.flatten() }, 400);
  }
  const { title, description, starts_at, ends_at } = parsed.data;
  if (Date.parse(ends_at) <= Date.parse(starts_at)) {
    return c.json({ error: 'ends_at must be after starts_at' }, 400);
  }
  const id = newId('mw');
  await c.env.DB.prepare(
    `INSERT INTO maintenance_windows
       (id, title, description, starts_at, ends_at, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, title, description, starts_at, ends_at, user.id, new Date().toISOString())
    .run();
  return c.json({ id, title, starts_at, ends_at }, 201);
});
