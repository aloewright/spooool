import { Hono } from 'hono';
import { z } from 'zod';
import { isAdmin, type RolesEnv } from './roles';

export interface StatusEnv extends RolesEnv {
  DB: D1Database;
}

type SessionUser = { id: string; email: string; name: string } | null;
type StatusVariables = { user: SessionUser };

// ── Schemas ───────────────────────────────────────────────────────────────────

const createIncidentSchema = z.object({
  title:      z.string().min(1).max(200),
  impact:     z.enum(['none', 'minor', 'major', 'critical']),
  message:    z.string().min(1).max(2000),
  started_at: z.string().optional(),
});

const updateIncidentSchema = z.object({
  title:  z.string().min(1).max(200).optional(),
  impact: z.enum(['none', 'minor', 'major', 'critical']).optional(),
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
});

const addUpdateSchema = z.object({
  message: z.string().min(1).max(2000),
  status:  z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
});

const createMaintenanceSchema = z.object({
  title:           z.string().min(1).max(200),
  description:     z.string().max(2000).optional().default(''),
  scheduled_start: z.string(),
  scheduled_end:   z.string(),
});

const updateMaintenanceSchema = z.object({
  title:           z.string().min(1).max(200).optional(),
  description:     z.string().max(2000).optional(),
  scheduled_start: z.string().optional(),
  scheduled_end:   z.string().optional(),
  status:          z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
});

const incidentsQuerySchema = z.object({
  resolved: z.enum(['true', 'false', 'all']).default('false'),
  limit:    z.coerce.number().int().positive().max(100).default(20),
  page:     z.coerce.number().int().positive().default(1),
});

// ── Row types ─────────────────────────────────────────────────────────────────

interface SnapshotRow {
  status: string;
  db_status: string; db_latency_ms: number | null;
  cache_status: string; cache_latency_ms: number | null;
  storage_status: string; storage_latency_ms: number | null;
  checked_at: string;
}

interface IncidentRow {
  id: string; title: string; impact: string; status: string;
  started_at: string; resolved_at: string | null; updated_at: string;
}

interface MaintenanceRow {
  id: string; title: string; description: string;
  scheduled_start: string; scheduled_end: string; status: string;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const statusRoutes = new Hono<{
  Bindings: StatusEnv;
  Variables: StatusVariables;
}>();

// ── Public endpoints ──────────────────────────────────────────────────────────

statusRoutes.get('/api/status', async (c) => {
  const now = new Date().toISOString();

  const [snapshot, { results: active }, { results: maintenance }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT status, db_status, db_latency_ms, cache_status, cache_latency_ms,
              storage_status, storage_latency_ms, checked_at
       FROM health_snapshots ORDER BY checked_at DESC LIMIT 1`,
    ).first<SnapshotRow>(),

    c.env.DB.prepare(
      `SELECT id, title, impact, status, started_at, resolved_at, updated_at
       FROM incidents WHERE status != 'resolved' ORDER BY started_at DESC LIMIT 10`,
    ).all<IncidentRow>(),

    c.env.DB.prepare(
      `SELECT id, title, description, scheduled_start, scheduled_end, status
       FROM maintenance_windows
       WHERE status IN ('scheduled','in_progress') AND scheduled_end > ?
       ORDER BY scheduled_start ASC LIMIT 5`,
    ).bind(now).all<MaintenanceRow>(),
  ]);

  const activeIncidents = active ?? [];
  const hasCritical = activeIncidents.some((i) => i.impact === 'critical');
  const hasMajor    = activeIncidents.some((i) => i.impact === 'major');
  const hasMinor    = activeIncidents.some((i) => i.impact === 'minor' || i.impact === 'none');

  let overallStatus: 'operational' | 'degraded' | 'partial_outage' | 'major_outage' = 'operational';
  if (hasCritical) overallStatus = 'major_outage';
  else if (hasMajor) overallStatus = 'partial_outage';
  else if (hasMinor || snapshot?.status === 'degraded') overallStatus = 'degraded';

  const toComponentStatus = (s: string) =>
    s === 'ok' ? 'operational' : s === 'skip' ? 'unknown' : 'degraded';

  const components = snapshot
    ? [
        { name: 'Database',      status: toComponentStatus(snapshot.db_status),      latency_ms: snapshot.db_latency_ms },
        { name: 'Video Storage', status: toComponentStatus(snapshot.storage_status),  latency_ms: snapshot.storage_latency_ms },
        { name: 'Sessions',      status: toComponentStatus(snapshot.cache_status),    latency_ms: snapshot.cache_latency_ms },
      ]
    : [];

  return c.json({
    status: overallStatus,
    components,
    activeIncidents,
    scheduledMaintenance: maintenance ?? [],
    lastChecked: snapshot?.checked_at ?? null,
    timestamp: now,
  });
});

statusRoutes.get('/api/status/incidents', async (c) => {
  const parsed = incidentsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid query' }, 400);
  const { resolved, limit, page } = parsed.data;
  const offset = (page - 1) * limit;

  const where =
    resolved === 'all'   ? '' :
    resolved === 'true'  ? `WHERE status = 'resolved'` :
                           `WHERE status != 'resolved'`;

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, impact, status, started_at, resolved_at, updated_at
     FROM incidents ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<IncidentRow>();

  return c.json({ page, limit, incidents: results ?? [] });
});

statusRoutes.get('/api/status/incidents/:id', async (c) => {
  const id = c.req.param('id');
  const [incident, { results: updates }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, impact, status, started_at, resolved_at, created_at, updated_at
       FROM incidents WHERE id = ?`,
    ).bind(id).first<IncidentRow & { created_at: string }>(),

    c.env.DB.prepare(
      `SELECT id, message, status, created_at FROM incident_updates
       WHERE incident_id = ? ORDER BY created_at DESC`,
    ).bind(id).all<{ id: string; message: string; status: string; created_at: string }>(),
  ]);

  if (!incident) return c.json({ error: 'Not found' }, 404);
  return c.json({ incident, updates: updates ?? [] });
});

statusRoutes.get('/api/status/uptime', async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 90)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { results } = await c.env.DB.prepare(
    `SELECT
       strftime('%Y-%m-%d', checked_at) AS day,
       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
       COUNT(*) AS total_count
     FROM health_snapshots WHERE checked_at >= ?
     GROUP BY day ORDER BY day ASC`,
  ).bind(since).all<{ day: string; ok_count: number; total_count: number }>();

  const daysData = (results ?? []).map((r) => ({
    date: r.day,
    uptime_pct: r.total_count > 0
      ? Math.round((Number(r.ok_count) / Number(r.total_count)) * 10_000) / 100
      : 100,
  }));

  const overall =
    daysData.length === 0
      ? 100
      : Math.round((daysData.reduce((s, d) => s + d.uptime_pct, 0) / daysData.length) * 100) / 100;

  return c.json({ days, since, uptime_pct: overall, days_data: daysData });
});

// ── Admin guard ───────────────────────────────────────────────────────────────

statusRoutes.use('/api/admin/status/*', async (c, next) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) return c.json({ error: 'Forbidden' }, 403);
  await next();
});

// ── Admin: incidents ──────────────────────────────────────────────────────────

statusRoutes.post('/api/admin/status/incidents', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = createIncidentSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const { title, impact, message, started_at } = parsed.data;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const updateId = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO incidents (id, title, impact, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'investigating', ?, ?, ?)`,
    ).bind(id, title, impact, started_at ?? now, now, now),
    c.env.DB.prepare(
      `INSERT INTO incident_updates (id, incident_id, message, status, created_at)
       VALUES (?, ?, ?, 'investigating', ?)`,
    ).bind(updateId, id, message, now),
  ]);

  return c.json({ id, status: 'investigating' }, 201);
});

statusRoutes.put('/api/admin/status/incidents/:id', async (c) => {
  const incidentId = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM incidents WHERE id = ?')
    .bind(incidentId).first<{ id: string }>();
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const json = await c.req.json().catch(() => null);
  const parsed = updateIncidentSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (parsed.data.title  !== undefined) { setClauses.push('title = ?');  values.push(parsed.data.title); }
  if (parsed.data.impact !== undefined) { setClauses.push('impact = ?'); values.push(parsed.data.impact); }
  if (parsed.data.status !== undefined) {
    setClauses.push('status = ?');
    values.push(parsed.data.status);
    if (parsed.data.status === 'resolved') { setClauses.push('resolved_at = ?'); values.push(now); }
  }
  if (setClauses.length === 0) return c.json({ error: 'No fields to update' }, 400);
  setClauses.push('updated_at = ?');
  values.push(now, incidentId);

  await c.env.DB.prepare(`UPDATE incidents SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values).run();

  return c.json({ id: incidentId, updated: true });
});

statusRoutes.post('/api/admin/status/incidents/:id/updates', async (c) => {
  const incidentId = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM incidents WHERE id = ?')
    .bind(incidentId).first<{ id: string }>();
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const json = await c.req.json().catch(() => null);
  const parsed = addUpdateSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const { message, status } = parsed.data;
  const now = new Date().toISOString();
  const updateId = crypto.randomUUID();

  const incidentUpdate = c.env.DB.prepare(
    `UPDATE incidents SET status = ?, updated_at = ?${status === 'resolved' ? ', resolved_at = ?' : ''} WHERE id = ?`,
  ).bind(status, now, ...(status === 'resolved' ? [now, incidentId] : [incidentId]));

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO incident_updates (id, incident_id, message, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(updateId, incidentId, message, status, now),
    incidentUpdate,
  ]);

  return c.json({ id: updateId, status }, 201);
});

// ── Admin: maintenance ────────────────────────────────────────────────────────

statusRoutes.post('/api/admin/status/maintenance', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = createMaintenanceSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const { title, description, scheduled_start, scheduled_end } = parsed.data;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO maintenance_windows (id, title, description, scheduled_start, scheduled_end, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
  ).bind(id, title, description, scheduled_start, scheduled_end, now, now).run();

  return c.json({ id, status: 'scheduled' }, 201);
});

statusRoutes.put('/api/admin/status/maintenance/:id', async (c) => {
  const maintenanceId = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM maintenance_windows WHERE id = ?')
    .bind(maintenanceId).first<{ id: string }>();
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const json = await c.req.json().catch(() => null);
  const parsed = updateMaintenanceSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const { title, description, scheduled_start, scheduled_end, status } = parsed.data;
  if (title           !== undefined) { setClauses.push('title = ?');           values.push(title); }
  if (description     !== undefined) { setClauses.push('description = ?');     values.push(description); }
  if (scheduled_start !== undefined) { setClauses.push('scheduled_start = ?'); values.push(scheduled_start); }
  if (scheduled_end   !== undefined) { setClauses.push('scheduled_end = ?');   values.push(scheduled_end); }
  if (status          !== undefined) { setClauses.push('status = ?');          values.push(status); }
  if (setClauses.length === 0) return c.json({ error: 'No fields to update' }, 400);
  setClauses.push('updated_at = ?');
  values.push(now, maintenanceId);

  await c.env.DB.prepare(`UPDATE maintenance_windows SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values).run();

  return c.json({ id: maintenanceId, updated: true });
});
