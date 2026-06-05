// ALO-176: cost monitoring + alerts.
//
// Aggregates the few D1 counters that drive Cloudflare bill growth (R2
// storage, video count, user count) and produces a back-of-the-envelope
// monthly cost estimate. The /api/admin/costs endpoint exposes the snapshot
// for the admin dashboard; runCostMonitorSweep is called from the daily
// cron in src/workers/index.ts and sends a cost-alert email to each
// configured admin via Cloudflare Email Service when any threshold trips.
//
// Idempotency: the daily KV marker `costs:alert:YYYY-MM-DD` is set after a
// successful send so a re-fired cron in the same UTC day stays silent.
// Without this, the daily sweep would re-page admins every time the worker
// rebooted, which is mostly noise.

import { Hono } from 'hono';
import { sendCostAlertEmail, type EmailEnv } from './email';
import { parseAdminEmails } from './moderation';
import { isAdmin } from './roles';

export interface CostsEnv extends EmailEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  ADMIN_EMAILS?: string;
  // Soft threshold in bytes; cost summary is mailed once a day once total
  // storage exceeds this. Defaults to 100 GiB.
  COST_STORAGE_ALERT_BYTES?: string;
  // Soft threshold in USD; cost summary is mailed once a day once cumulative
  // AI spend exceeds this. Unset = no AI spend alerting.
  COST_AI_SPEND_ALERT_USD?: string;
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

// Workers AI generation cost estimates (order-of-magnitude; billed in Neurons
// on the Cloudflare dashboard — these are the USD back-of-envelope equivalents
// written into ai_costs.est_usd at generation time).
export const PRICE_AI_PER_IMAGE_FLUX_SCHNELL = 0.0013;
export const PRICE_AI_CHAT_PER_M_TOKENS = 0.80; // Gemma-4 blended estimate

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
  ai_spend: {
    /** Cumulative est_usd across all ai_costs rows (all time). */
    total_usd: number;
    last_30d_usd: number;
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
  // we compare lexicographically; user.createdAt and ai_costs.created_at are
  // INTEGER ms (better-auth convention).
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
    aiSpendTotalRow,
    aiSpend30dRow,
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
    env.DB.prepare('SELECT COALESCE(SUM(est_usd), 0) AS used FROM ai_costs').first<SumRow>(),
    env.DB.prepare('SELECT COALESCE(SUM(est_usd), 0) AS used FROM ai_costs WHERE created_at >= ?')
      .bind(thirtyDaysAgoMs)
      .first<SumRow>(),
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
    ai_spend: {
      total_usd: roundCents(Number(aiSpendTotalRow?.used ?? 0)),
      last_30d_usd: roundCents(Number(aiSpend30dRow?.used ?? 0)),
    },
  };
}

function roundCents(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export type CostAlert =
  | { reason: 'storage_threshold'; threshold_bytes: number; observed_bytes: number }
  | { reason: 'ai_spend_threshold'; threshold_usd: number; observed_usd: number };

export function evaluateAlerts(
  snapshot: CostSnapshot,
  thresholdBytes: number,
  aiSpendThresholdUsd?: number,
): CostAlert[] {
  const alerts: CostAlert[] = [];
  if (snapshot.storage.used_bytes >= thresholdBytes) {
    alerts.push({
      reason: 'storage_threshold',
      threshold_bytes: thresholdBytes,
      observed_bytes: snapshot.storage.used_bytes,
    });
  }
  if (aiSpendThresholdUsd !== undefined && snapshot.ai_spend.total_usd >= aiSpendThresholdUsd) {
    alerts.push({
      reason: 'ai_spend_threshold',
      threshold_usd: aiSpendThresholdUsd,
      observed_usd: snapshot.ai_spend.total_usd,
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

export function parseThresholdUsd(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export function todayKey(now: Date = new Date()): string {
  // YYYY-MM-DD in UTC.
  return `costs:alert:${now.toISOString().slice(0, 10)}`;
}

// Flat property bag rendered into the cost-alert email body. Kept as
// primitives so the email template can format each field directly.
export function buildCostAlertProps(
  snapshot: CostSnapshot,
  alerts: CostAlert[],
): Record<string, string | number> {
  const gib = snapshot.storage.used_gib.toFixed(2);
  const usd = snapshot.storage.estimated_monthly_usd.toFixed(2);
  const reasons = alerts.map((a) => a.reason).join(',');
  const storageAlert = alerts.find(
    (a): a is Extract<CostAlert, { reason: 'storage_threshold' }> => a.reason === 'storage_threshold',
  );
  const aiSpendAlert = alerts.find(
    (a): a is Extract<CostAlert, { reason: 'ai_spend_threshold' }> => a.reason === 'ai_spend_threshold',
  );
  return {
    generated_at: snapshot.generated_at,
    storage_gib: gib,
    storage_usd_per_month: usd,
    threshold_gib: storageAlert ? (storageAlert.threshold_bytes / (1024 * 1024 * 1024)).toFixed(2) : '',
    alert_reasons: reasons,
    ai_spend_total_usd: snapshot.ai_spend.total_usd.toFixed(4),
    ai_spend_last_30d_usd: snapshot.ai_spend.last_30d_usd.toFixed(4),
    ai_spend_threshold_usd: aiSpendAlert ? aiSpendAlert.threshold_usd.toFixed(2) : '',
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
  const aiSpendThreshold = parseThresholdUsd(env.COST_AI_SPEND_ALERT_USD);
  const alerts = evaluateAlerts(snapshot, threshold, aiSpendThreshold);
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

  const props = buildCostAlertProps(snapshot, alerts);
  for (const to of recipients) {
    await sendCostAlertEmail(env, { to, props });
  }
  // Set the dedup marker only after the sends fire; even if the email
  // binding returned an error result we still consider the day "delivered"
  // — retrying would just re-page admins every cron tick. Operators can
  // manually clear the KV key to force a re-send during incident triage.
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
  const aiSpendThreshold = parseThresholdUsd(c.env.COST_AI_SPEND_ALERT_USD);
  return c.json({
    snapshot,
    threshold_bytes: threshold,
    ai_spend_threshold_usd: aiSpendThreshold ?? null,
    alerts: evaluateAlerts(snapshot, threshold, aiSpendThreshold),
  });
});
