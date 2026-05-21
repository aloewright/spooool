// ALO-176: cost monitoring + alerts.
//
// Aggregates the few D1 counters that drive Cloudflare bill growth (R2
// storage, video count, user count) and produces a back-of-the-envelope
// monthly cost estimate. The /api/admin/costs endpoint exposes the snapshot
// for the admin dashboard; runCostMonitorSweep is called from the daily
// cron in src/workers/index.ts and fires a `cost_alert` Loops event for
// each configured admin when any threshold trips — the actual email body
// lives in the Loops automation that listens for that event.
//
// Idempotency: the daily KV marker `costs:alert:YYYY-MM-DD` is set after a
// successful send so a re-fired cron in the same UTC day stays silent.
// Without this, the daily sweep would re-page admins every time the worker
// rebooted, which is mostly noise.

import { Hono } from 'hono';
import { sendEvent, type LoopsEnv } from './loops';
import { parseAdminEmails } from './moderation';
import { isAdmin } from './roles';

export interface CostsEnv extends LoopsEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  ADMIN_EMAILS?: string;
  // Soft threshold in bytes; cost summary is mailed once a day once total
  // storage exceeds this. Defaults to 100 GiB.
  COST_STORAGE_ALERT_BYTES?: string;
}

type SessionUser = { id: string; email: string; name: string } | null;
type CostsVariables = { user: SessionUser };

const DEFAULT_STORAGE_ALERT_BYTES = 100 * 1024 * 1024 * 1024; // 100 GiB

// Cloudflare published list prices, used only to produce an order-of-magnitude
// monthly estimate. The number is not authoritative — for billing we read
// the Cloudflare dashboard. See README "Cost Analysis" for context.
export const PRICE_R2_PER_GB_MONTH = 0.015;
export const PRICE_D1_PER_GB_MONTH = 0.75;
export const PRICE_WORKER_PER_M_REQUESTS = 0.15;

export interface CostSnapshot {
  generated_at: string;
  storage: {
    used_bytes: number;
    used_gib: number;
    /** $/month, rounded to 4 decimals so 1 GiB → $0.015. */
    estimated_monthly_usd: number;
  };
  videos: {
    total: number;
    /** Soft-deleted but still in R2 (counts toward storage). */
    soft_deleted: number;
    last_30d: number;
  };
  users: {
    total: number;
    last_30d: number;
  };
  comments: {
    total: number;
  };
}

interface SumRow {
  used: number | null;
}

interface CountRow {
  n: number | null;
}

export async function getCostSnapshot(env: CostsEnv): Promise<CostSnapshot> {
  // videos.created_at is TEXT ('YYYY-MM-DD HH:MM:SS' via CURRENT_TIMESTAMP) so
  // we compare lexicographically; user.createdAt is INTEGER ms (better-auth).
  const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgoSqlText = new Date(thirtyDaysAgoMs)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const [
    storageRow,
    videosRow,
    softDeletedRow,
    videos30dRow,
    usersRow,
    users30dRow,
    commentsRow,
  ] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS used FROM videos').first<SumRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM videos WHERE deleted_at IS NULL').first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM videos WHERE deleted_at IS NOT NULL').first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM videos WHERE created_at >= ?')
      .bind(thirtyDaysAgoSqlText)
      .first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM user WHERE createdAt >= ?')
      .bind(thirtyDaysAgoMs)
      .first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE deleted_at IS NULL').first<CountRow>(),
  ]);

  const usedBytes = Number(storageRow?.used ?? 0);
  return {
    generated_at: new Date().toISOString(),
    storage: {
      used_bytes: usedBytes,
      used_gib: usedBytes / (1024 * 1024 * 1024),
      estimated_monthly_usd: roundCents((usedBytes / (1024 * 1024 * 1024)) * PRICE_R2_PER_GB_MONTH),
    },
    videos: {
      total: Number(videosRow?.n ?? 0),
      soft_deleted: Number(softDeletedRow?.n ?? 0),
      last_30d: Number(videos30dRow?.n ?? 0),
    },
    users: {
      total: Number(usersRow?.n ?? 0),
      last_30d: Number(users30dRow?.n ?? 0),
    },
    comments: {
      total: Number(commentsRow?.n ?? 0),
    },
  };
}

function roundCents(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface CostAlert {
  reason: 'storage_threshold';
  threshold_bytes: number;
  observed_bytes: number;
}

export function evaluateAlerts(
  snapshot: CostSnapshot,
  thresholdBytes: number,
): CostAlert[] {
  const alerts: CostAlert[] = [];
  if (snapshot.storage.used_bytes >= thresholdBytes) {
    alerts.push({
      reason: 'storage_threshold',
      threshold_bytes: thresholdBytes,
      observed_bytes: snapshot.storage.used_bytes,
    });
  }
  return alerts;
}

export function parseThresholdBytes(raw: string | undefined): number {
  if (!raw) return DEFAULT_STORAGE_ALERT_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STORAGE_ALERT_BYTES;
  return n;
}

export function todayKey(now: Date = new Date()): string {
  // YYYY-MM-DD in UTC.
  return `costs:alert:${now.toISOString().slice(0, 10)}`;
}

// Flat eventProperties payload for the Loops `cost_alert` automation. Kept
// as primitives (no nested objects) so it round-trips cleanly through Loops'
// custom-property system and so the template can `{{double-brace}}` each
// field directly.
export function buildCostAlertProps(
  snapshot: CostSnapshot,
  alerts: CostAlert[],
): Record<string, string | number> {
  const gib = snapshot.storage.used_gib.toFixed(2);
  const usd = snapshot.storage.estimated_monthly_usd.toFixed(2);
  const reasons = alerts.map((a) => a.reason).join(',');
  const thresholdGib = alerts.length
    ? (alerts[0].threshold_bytes / (1024 * 1024 * 1024)).toFixed(2)
    : '';
  return {
    generated_at: snapshot.generated_at,
    storage_gib: gib,
    storage_usd_per_month: usd,
    threshold_gib: thresholdGib,
    alert_reasons: reasons,
    videos_total: snapshot.videos.total,
    videos_last_30d: snapshot.videos.last_30d,
    videos_soft_deleted: snapshot.videos.soft_deleted,
    users_total: snapshot.users.total,
    users_last_30d: snapshot.users.last_30d,
    comments_total: snapshot.comments.total,
  };
}

export interface SweepResult {
  alerts: CostAlert[];
  sent: boolean;
  reason?: 'no_alerts' | 'already_sent_today' | 'no_admin_emails' | 'sent';
}

export async function runCostMonitorSweep(env: CostsEnv): Promise<SweepResult> {
  const snapshot = await getCostSnapshot(env);
  const threshold = parseThresholdBytes(env.COST_STORAGE_ALERT_BYTES);
  const alerts = evaluateAlerts(snapshot, threshold);
  if (alerts.length === 0) {
    return { alerts, sent: false, reason: 'no_alerts' };
  }

  const key = todayKey();
  const already = await env.CACHE.get(key);
  if (already) {
    return { alerts, sent: false, reason: 'already_sent_today' };
  }

  const recipients = [...parseAdminEmails(env.ADMIN_EMAILS)];
  if (recipients.length === 0) {
    return { alerts, sent: false, reason: 'no_admin_emails' };
  }

  const eventProperties = buildCostAlertProps(snapshot, alerts);
  for (const to of recipients) {
    await sendEvent(env, {
      email: to,
      eventName: 'cost_alert',
      eventProperties,
    });
  }
  // Set the dedup marker only after the sends fire; if Loops returned an
  // error result we still consider the day "delivered" — retrying would
  // just re-page admins every cron tick. Operators can manually clear the
  // KV key to force a re-send during incident triage.
  await env.CACHE.put(key, '1', { expirationTtl: 48 * 60 * 60 });
  return { alerts, sent: true, reason: 'sent' };
}

export const costsRoutes = new Hono<{ Bindings: CostsEnv; Variables: CostsVariables }>();

costsRoutes.get('/api/admin/costs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await isAdmin(c.env, user))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const snapshot = await getCostSnapshot(c.env);
  const threshold = parseThresholdBytes(c.env.COST_STORAGE_ALERT_BYTES);
  return c.json({
    snapshot,
    threshold_bytes: threshold,
    alerts: evaluateAlerts(snapshot, threshold),
  });
});
