// ALO-176: daily cost monitoring + over-threshold alerts + per-creator
// cost attribution.
//
// The cron handler (see workers/index.ts → scheduled) calls
// `runCostSnapshot` once per day. It estimates spend from what we can
// measure inside the worker (videos.bytes for storage, optional
// CF_BILLING_USD_CENTS_OVERRIDE for an authoritative figure pushed in
// from a Cloudflare billing fetcher), inserts a row into cost_snapshots,
// and — if total > COST_ALERT_THRESHOLD_USD_CENTS — emails the configured
// recipient through Resend.
//
// `getCreatorCostAttribution` powers the admin dashboard: it joins
// videos.bytes by user_id and applies the same per-GB rate so cost is
// attributable end-to-end without a separate billing pipeline.
//
// Pure helpers (`estimateCosts`, `formatAlertEmail`, `pickAlertRecipient`)
// are exported for unit tests.

import { Hono } from 'hono';
import { sendEmail, type ResendEnv } from './resend';
import { isAdmin } from './roles';

// Default rates. Override via env to model contracted pricing.
// Numbers are USD cents per unit so all math stays integer.
export interface CostRates {
  storagePerGbCents: number;
  egressPerGbCents: number;
  streamMinutePerHourCents: number;
}

export const DEFAULT_RATES: CostRates = {
  storagePerGbCents: 1.5,    // R2 standard ~ $0.015/GB-month
  egressPerGbCents: 0,       // R2 egress is free; placeholder for future Stream
  streamMinutePerHourCents: 100, // Stream ~ $1/1000 minutes delivered
};

export interface CostBreakdown {
  storageCents: number;
  egressCents: number;
  streamCents: number;
  overrideCents?: number;
}

export interface CostSnapshot {
  snapshotDate: string;
  totalUsdCents: number;
  storageBytes: number;
  activeCreators: number;
  breakdown: CostBreakdown;
  alertedAt: number | null;
  createdAt: number;
}

export interface CostMonitorEnv extends ResendEnv {
  DB: D1Database;
  /** Recipient for cost-alert emails. Falls back to the first ADMIN_EMAILS entry. */
  COST_ALERT_EMAIL?: string;
  ADMIN_EMAILS?: string;
  /** USD cents — when total spend exceeds this, send an alert. Default: $5000. */
  COST_ALERT_THRESHOLD_USD_CENTS?: string;
  /** Optional authoritative billing figure (USD cents) pulled from the Cloudflare API
   *  by a separate sync. If set, `total = override`; otherwise it's the sum of
   *  the estimated breakdown. */
  CF_BILLING_USD_CENTS_OVERRIDE?: string;
  /** Override per-GB storage rate (cents). */
  COST_RATE_STORAGE_PER_GB_CENTS?: string;
  /** Override per-GB egress rate (cents). */
  COST_RATE_EGRESS_PER_GB_CENTS?: string;
  /** Override per-hour Stream delivery rate (cents per delivered hour). */
  COST_RATE_STREAM_PER_HOUR_CENTS?: string;
}

export const DEFAULT_ALERT_THRESHOLD_USD_CENTS = 500_000; // $5,000

const BYTES_PER_GB = 1024 ** 3;

export function ratesFromEnv(env: CostMonitorEnv): CostRates {
  const num = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    storagePerGbCents: num(env.COST_RATE_STORAGE_PER_GB_CENTS, DEFAULT_RATES.storagePerGbCents),
    egressPerGbCents: num(env.COST_RATE_EGRESS_PER_GB_CENTS, DEFAULT_RATES.egressPerGbCents),
    streamMinutePerHourCents: num(
      env.COST_RATE_STREAM_PER_HOUR_CENTS,
      DEFAULT_RATES.streamMinutePerHourCents,
    ),
  };
}

export interface UsageSummary {
  storageBytes: number;
  egressBytes: number;
  streamHours: number;
}

export function estimateCosts(usage: UsageSummary, rates: CostRates): CostBreakdown {
  const storageGb = usage.storageBytes / BYTES_PER_GB;
  const egressGb = usage.egressBytes / BYTES_PER_GB;
  return {
    storageCents: Math.round(storageGb * rates.storagePerGbCents),
    egressCents: Math.round(egressGb * rates.egressPerGbCents),
    streamCents: Math.round(usage.streamHours * rates.streamMinutePerHourCents),
  };
}

export function totalFromBreakdown(b: CostBreakdown): number {
  if (typeof b.overrideCents === 'number') return b.overrideCents;
  return b.storageCents + b.egressCents + b.streamCents;
}

export function pickAlertRecipient(env: CostMonitorEnv): string | null {
  if (env.COST_ALERT_EMAIL && env.COST_ALERT_EMAIL.includes('@')) {
    return env.COST_ALERT_EMAIL.trim();
  }
  const first = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.includes('@'));
  return first ?? null;
}

export function formatAlertEmail(args: {
  totalUsdCents: number;
  thresholdUsdCents: number;
  snapshotDate: string;
  breakdown: CostBreakdown;
}): { subject: string; html: string } {
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const subject = `[spooool] cost alert ${args.snapshotDate}: ${fmt(args.totalUsdCents)} > ${fmt(
    args.thresholdUsdCents,
  )}`;
  const html = `<p>Daily cost snapshot exceeded the alert threshold.</p>
<ul>
  <li>Date (UTC): <strong>${args.snapshotDate}</strong></li>
  <li>Total: <strong>${fmt(args.totalUsdCents)}</strong></li>
  <li>Threshold: ${fmt(args.thresholdUsdCents)}</li>
  <li>Storage: ${fmt(args.breakdown.storageCents)}</li>
  <li>Egress: ${fmt(args.breakdown.egressCents)}</li>
  <li>Stream: ${fmt(args.breakdown.streamCents)}</li>
</ul>
<p>Investigate via the admin dashboard at <code>/api/admin/costs</code>.</p>`;
  return { subject, html };
}

interface UsageRow {
  storage_bytes: number | null;
  active_creators: number | null;
}

async function readUsage(env: CostMonitorEnv): Promise<UsageSummary & { activeCreators: number }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(bytes), 0) AS storage_bytes,
            COUNT(DISTINCT user_id) AS active_creators
     FROM videos
     WHERE deleted_at IS NULL`,
  ).first<UsageRow>();
  return {
    storageBytes: Number(row?.storage_bytes ?? 0),
    egressBytes: 0,
    streamHours: 0,
    activeCreators: Number(row?.active_creators ?? 0),
  };
}

export type SnapshotResult =
  | { ok: true; snapshot: CostSnapshot; alerted: boolean; alertSkippedReason?: string }
  | { ok: false; error: string };

export async function runCostSnapshot(env: CostMonitorEnv, now: Date = new Date()): Promise<SnapshotResult> {
  try {
    const date = now.toISOString().slice(0, 10);
    const usage = await readUsage(env);
    const breakdown = estimateCosts(usage, ratesFromEnv(env));
    const override = env.CF_BILLING_USD_CENTS_OVERRIDE
      ? Number(env.CF_BILLING_USD_CENTS_OVERRIDE)
      : NaN;
    if (Number.isFinite(override) && override >= 0) {
      breakdown.overrideCents = Math.round(override);
    }
    const total = totalFromBreakdown(breakdown);

    await env.DB.prepare(
      `INSERT INTO cost_snapshots (
         snapshot_date, total_usd_cents, storage_bytes, active_creators, breakdown_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_date) DO UPDATE SET
         total_usd_cents = excluded.total_usd_cents,
         storage_bytes = excluded.storage_bytes,
         active_creators = excluded.active_creators,
         breakdown_json = excluded.breakdown_json`,
    )
      .bind(date, total, usage.storageBytes, usage.activeCreators, JSON.stringify(breakdown))
      .run();

    const threshold = Number(env.COST_ALERT_THRESHOLD_USD_CENTS ?? '');
    const effectiveThreshold = Number.isFinite(threshold) && threshold > 0
      ? threshold
      : DEFAULT_ALERT_THRESHOLD_USD_CENTS;

    let alerted = false;
    let alertSkippedReason: string | undefined;
    const existing = await env.DB.prepare(
      'SELECT alerted_at FROM cost_snapshots WHERE snapshot_date = ?',
    )
      .bind(date)
      .first<{ alerted_at: number | null }>();

    if (total > effectiveThreshold && !existing?.alerted_at) {
      const recipient = pickAlertRecipient(env);
      if (!recipient) {
        alertSkippedReason = 'no recipient configured';
      } else {
        const { subject, html } = formatAlertEmail({
          totalUsdCents: total,
          thresholdUsdCents: effectiveThreshold,
          snapshotDate: date,
          breakdown,
        });
        const send = await sendEmail(env, { to: recipient, subject, html });
        if (send.ok) {
          alerted = true;
          await env.DB.prepare(
            'UPDATE cost_snapshots SET alerted_at = ? WHERE snapshot_date = ?',
          )
            .bind(now.getTime(), date)
            .run();
        } else if (send.skipped) {
          alertSkippedReason = send.reason;
        } else {
          alertSkippedReason = `resend ${send.status}: ${send.message}`;
        }
      }
    }

    const snapshot: CostSnapshot = {
      snapshotDate: date,
      totalUsdCents: total,
      storageBytes: usage.storageBytes,
      activeCreators: usage.activeCreators,
      breakdown,
      alertedAt: alerted ? now.getTime() : (existing?.alerted_at ?? null),
      createdAt: now.getTime(),
    };
    return { ok: true, snapshot, alerted, alertSkippedReason };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CreatorCostRow {
  userId: string;
  email: string | null;
  storageBytes: number;
  videos: number;
  estimatedUsdCents: number;
}

export async function getCreatorCostAttribution(
  env: CostMonitorEnv,
  limit = 50,
): Promise<CreatorCostRow[]> {
  const rates = ratesFromEnv(env);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const { results } = await env.DB.prepare(
    `SELECT v.user_id AS user_id,
            u.email AS email,
            COALESCE(SUM(v.bytes), 0) AS storage_bytes,
            COUNT(v.id) AS video_count
     FROM videos v
     LEFT JOIN user u ON u.id = v.user_id
     WHERE v.deleted_at IS NULL
     GROUP BY v.user_id
     ORDER BY storage_bytes DESC
     LIMIT ?`,
  )
    .bind(safeLimit)
    .all<{
      user_id: string;
      email: string | null;
      storage_bytes: number;
      video_count: number;
    }>();
  return (results ?? []).map((r) => {
    const bytes = Number(r.storage_bytes ?? 0);
    const estimatedUsdCents = Math.round((bytes / BYTES_PER_GB) * rates.storagePerGbCents);
    return {
      userId: r.user_id,
      email: r.email,
      storageBytes: bytes,
      videos: Number(r.video_count ?? 0),
      estimatedUsdCents,
    };
  });
}

interface SnapshotRow {
  snapshot_date: string;
  total_usd_cents: number;
  storage_bytes: number;
  active_creators: number;
  breakdown_json: string;
  alerted_at: number | null;
  created_at: number;
}

export async function listCostSnapshots(
  env: CostMonitorEnv,
  limit = 30,
): Promise<CostSnapshot[]> {
  const safeLimit = Math.max(1, Math.min(365, Math.floor(limit)));
  const { results } = await env.DB.prepare(
    `SELECT snapshot_date, total_usd_cents, storage_bytes, active_creators,
            breakdown_json, alerted_at, created_at
     FROM cost_snapshots
     ORDER BY snapshot_date DESC
     LIMIT ?`,
  )
    .bind(safeLimit)
    .all<SnapshotRow>();
  return (results ?? []).map((r) => ({
    snapshotDate: r.snapshot_date,
    totalUsdCents: r.total_usd_cents,
    storageBytes: r.storage_bytes,
    activeCreators: r.active_creators,
    breakdown: safeParseBreakdown(r.breakdown_json),
    alertedAt: r.alerted_at,
    createdAt: r.created_at,
  }));
}

function safeParseBreakdown(json: string): CostBreakdown {
  try {
    const parsed = JSON.parse(json) as Partial<CostBreakdown>;
    return {
      storageCents: Number(parsed.storageCents ?? 0),
      egressCents: Number(parsed.egressCents ?? 0),
      streamCents: Number(parsed.streamCents ?? 0),
      overrideCents:
        typeof parsed.overrideCents === 'number' ? parsed.overrideCents : undefined,
    };
  } catch {
    return { storageCents: 0, egressCents: 0, streamCents: 0 };
  }
}

type SessionUser = { id: string; email: string; name: string } | null;
type CostVariables = { user: SessionUser };

export const costRoutes = new Hono<{
  Bindings: CostMonitorEnv;
  Variables: CostVariables;
}>();

costRoutes.use('/api/admin/costs/*', async (c, next) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});
costRoutes.use('/api/admin/costs', async (c, next) => {
  const user = c.get('user');
  if (!(await isAdmin(c.env, user))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});

costRoutes.get('/api/admin/costs', async (c) => {
  const limit = Number(c.req.query('limit') ?? 30);
  const snapshots = await listCostSnapshots(c.env, Number.isFinite(limit) ? limit : 30);
  return c.json({ snapshots });
});

costRoutes.get('/api/admin/costs/creators', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  const creators = await getCreatorCostAttribution(c.env, Number.isFinite(limit) ? limit : 50);
  return c.json({ creators });
});

