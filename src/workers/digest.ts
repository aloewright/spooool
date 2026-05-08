// ALO-157: email-digest sweep. Runs from the worker's scheduled() handler
// (see workers/index.ts). For every user whose digest window has elapsed,
// aggregate new uploads from their subscriptions since the last digest and
// send a single Resend email summarising them. The user's
// `email_digest_last_sent_at` advances on success so the next sweep skips
// them until their window rolls over again.
//
// Failure mode: this is best-effort. A Resend non-2xx or skipped delivery
// (no API key configured) just leaves last_sent_at untouched so we'll try
// again on the next sweep. We never throw out of the sweep.

import { sendEmail, type ResendEnv } from './resend';

export interface DigestEnv extends ResendEnv {
  DB: D1Database;
}

export type DigestFrequency = 'off' | 'daily' | 'weekly';

export const DIGEST_WINDOW_MS: Record<Exclude<DigestFrequency, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// Cap on items rendered into a single digest. Subscribers to extremely
// active creators would otherwise get a 100-item email; we truncate and
// add a "+N more" footer.
export const DIGEST_MAX_ITEMS = 20;

export interface DigestUserRow {
  id: string;
  email: string;
  name: string;
  email_digest_frequency: DigestFrequency;
  email_digest_last_sent_at: number | null;
}

export interface DigestItem {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  channelUsername: string | null;
  channelName: string | null;
  addedAt: string;
}

export interface DigestResult {
  userId: string;
  email: string;
  itemCount: number;
  totalNewUploads: number;
  // 'sent' = Resend accepted the message and we updated last_sent_at.
  // 'skipped' = Resend not configured or no items in window — no DB write.
  // 'failed' = Resend returned an error; last_sent_at left alone.
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

// SELECTs users due for a digest. Eligible = freq != 'off' AND
// (last_sent_at IS NULL OR last_sent_at + window <= now). We compute the
// branch in SQL using two separate predicates so the CHECK constraint on
// the freq enum keeps the query well-typed.
export async function selectDueUsers(env: DigestEnv, nowMs: number): Promise<DigestUserRow[]> {
  const dailyCutoff = nowMs - DIGEST_WINDOW_MS.daily;
  const weeklyCutoff = nowMs - DIGEST_WINDOW_MS.weekly;
  const { results } = await env.DB.prepare(
    `SELECT id, email, name, email_digest_frequency, email_digest_last_sent_at
     FROM user
     WHERE email_digest_frequency != 'off'
       AND banned_at IS NULL
       AND deletion_scheduled_for IS NULL
       AND (
         (email_digest_frequency = 'daily'
            AND (email_digest_last_sent_at IS NULL OR email_digest_last_sent_at <= ?))
         OR (email_digest_frequency = 'weekly'
            AND (email_digest_last_sent_at IS NULL OR email_digest_last_sent_at <= ?))
       )`,
  )
    .bind(dailyCutoff, weeklyCutoff)
    .all<DigestUserRow>();
  return results ?? [];
}

// Items added to the user's subscription_inbox since `since` (epoch ms),
// joined with the video + channel display info we render into the email.
// Returns at most `limit + 1` rows so the caller can detect overflow.
export async function selectDigestItems(
  env: DigestEnv,
  userId: string,
  sinceMs: number,
  limit: number,
): Promise<DigestItem[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT i.video_id AS videoId,
            v.title AS title,
            v.thumbnail_url AS thumbnailUrl,
            u.username AS channelUsername,
            COALESCE(u.displayName, u.name) AS channelName,
            i.added_at AS addedAt
     FROM subscription_inbox i
     JOIN videos v ON v.id = i.video_id
       AND v.deleted_at IS NULL
       AND v.hidden_at IS NULL
     LEFT JOIN user u ON u.id = i.channel_user_id
     WHERE i.subscriber_user_id = ?
       AND i.added_at >= ?
     ORDER BY i.added_at DESC
     LIMIT ?`,
  )
    .bind(userId, sinceIso, limit + 1)
    .all<DigestItem>();
  return results ?? [];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderDigestArgs {
  recipientName: string;
  items: DigestItem[];
  totalNewUploads: number;
  frequency: 'daily' | 'weekly';
  baseUrl: string;
  unsubscribeUrl: string;
}

// Pure helper exported for unit tests. The HTML is intentionally minimal —
// inlined styles, no external assets — so it survives most email clients.
export function renderDigestEmail(args: RenderDigestArgs): { subject: string; html: string } {
  const greeting = args.recipientName ? `Hi ${escapeHtml(args.recipientName)},` : 'Hi,';
  const period = args.frequency === 'daily' ? 'Today' : 'This week';
  const subject =
    args.items.length === 1
      ? `${period} on spooool: 1 new upload from your subscriptions`
      : `${period} on spooool: ${args.items.length} new uploads from your subscriptions`;

  const itemsHtml = args.items
    .map((it) => {
      const watchUrl = `${args.baseUrl}/watch/${encodeURIComponent(it.videoId)}`;
      const channelName = it.channelName
        ? escapeHtml(it.channelName)
        : it.channelUsername
          ? escapeHtml(it.channelUsername)
          : 'a creator you subscribe to';
      const thumbnail = it.thumbnailUrl
        ? `<img src="${escapeHtml(it.thumbnailUrl)}" alt="" width="160" style="border-radius:6px;display:block;margin-bottom:8px;" />`
        : '';
      return `<li style="margin-bottom:16px;list-style:none;">
        ${thumbnail}
        <a href="${escapeHtml(watchUrl)}" style="font-weight:600;color:#0d6efd;text-decoration:none;">${escapeHtml(it.title)}</a>
        <div style="color:#555;font-size:13px;">${channelName}</div>
      </li>`;
    })
    .join('');

  const overflow =
    args.totalNewUploads > args.items.length
      ? `<p style="color:#555;font-size:13px;">…and ${args.totalNewUploads - args.items.length} more.
         <a href="${escapeHtml(args.baseUrl)}/?inbox=1">See all in your inbox →</a></p>`
      : '';

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#222;max-width:560px;">
    <p>${greeting}</p>
    <p>${period === 'Today' ? "Here's what your subscriptions posted today." : "Here's what your subscriptions posted this week."}</p>
    <ul style="padding:0;margin:0;">${itemsHtml}</ul>
    ${overflow}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
    <p style="color:#777;font-size:12px;">
      You're getting this because you're subscribed to creators on spooool. Don't want these?
      <a href="${escapeHtml(args.unsubscribeUrl)}">Update digest preferences</a>.
    </p>
  </div>`;

  return { subject, html };
}

export interface RunDigestSweepOptions {
  env: DigestEnv;
  nowMs?: number;
  // Public origin used to build watch URLs in emails. Falls back to the
  // Resend-from domain or a sensible default.
  baseUrl?: string;
}

export async function runDigestSweep(opts: RunDigestSweepOptions): Promise<DigestResult[]> {
  const { env } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const baseUrl = (opts.baseUrl ?? 'https://spooool.com').replace(/\/$/, '');
  const unsubscribeUrl = `${baseUrl}/settings/account#notifications`;

  const due = await selectDueUsers(env, nowMs);
  const out: DigestResult[] = [];

  for (const user of due) {
    if (user.email_digest_frequency === 'off') continue;
    const windowMs = DIGEST_WINDOW_MS[user.email_digest_frequency];
    // First-time users (last_sent_at IS NULL) get items from the last full
    // window so we don't accidentally pull every video they've ever seen
    // queued.
    const sinceMs = user.email_digest_last_sent_at ?? nowMs - windowMs;

    const fetched = await selectDigestItems(env, user.id, sinceMs, DIGEST_MAX_ITEMS);
    const items = fetched.slice(0, DIGEST_MAX_ITEMS);
    const totalNewUploads = fetched.length;

    if (items.length === 0) {
      // Still bump last_sent_at — otherwise an inactive creator's idle
      // subscriber would re-process the same empty window forever.
      await env.DB.prepare(
        `UPDATE user SET email_digest_last_sent_at = ?, updatedAt = ? WHERE id = ?`,
      )
        .bind(nowMs, nowMs, user.id)
        .run();
      out.push({
        userId: user.id,
        email: user.email,
        itemCount: 0,
        totalNewUploads: 0,
        status: 'skipped',
        reason: 'no items in window',
      });
      continue;
    }

    const { subject, html } = renderDigestEmail({
      recipientName: user.name?.split(' ')[0] ?? '',
      items,
      totalNewUploads,
      frequency: user.email_digest_frequency,
      baseUrl,
      unsubscribeUrl,
    });

    const result = await sendEmail(env, { to: user.email, subject, html });
    if (result.ok) {
      await env.DB.prepare(
        `UPDATE user SET email_digest_last_sent_at = ?, updatedAt = ? WHERE id = ?`,
      )
        .bind(nowMs, nowMs, user.id)
        .run();
      out.push({
        userId: user.id,
        email: user.email,
        itemCount: items.length,
        totalNewUploads,
        status: 'sent',
      });
    } else if (result.skipped) {
      out.push({
        userId: user.id,
        email: user.email,
        itemCount: items.length,
        totalNewUploads,
        status: 'skipped',
        reason: result.reason,
      });
    } else {
      out.push({
        userId: user.id,
        email: user.email,
        itemCount: items.length,
        totalNewUploads,
        status: 'failed',
        reason: result.message,
      });
    }
  }

  return out;
}
