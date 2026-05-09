// ALO-124: subscriber inbox -> Resend email digest.
//
// The fan-out DO populates `subscription_inbox` whenever a creator the user
// follows uploads a new video. This module rolls those rows up per recipient
// and sends a single "new uploads from creators you follow" email via Resend.
//
// Design:
//  - Pure helpers (renderInboxDigestEmail, groupItemsByRecipient) are easy to
//    unit-test and shared between the cron path and the admin trigger.
//  - Sending is idempotent per inbox row: we stamp `digest_sent_at` once the
//    Resend call succeeds so a retried sweep doesn't re-mail the same items.
//  - All Resend errors are tolerated. We log + skip so a flaky API key can't
//    block the cron.
//
// Schema dependency: 0019_inbox_email_digest.sql adds `digest_sent_at` and
// the partial index over (subscriber_user_id, added_at DESC) WHERE seen_at
// IS NULL AND digest_sent_at IS NULL.

import { sendEmail, type ResendEnv } from './resend';

export interface InboxDigestEnv extends ResendEnv {
  DB: D1Database;
  /** Public site origin used to build /watch/:id and /inbox links. */
  BETTER_AUTH_URL?: string;
}

export interface DigestItem {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  channelName: string;
  channelUsername: string | null;
  addedAt: string;
}

export interface DigestRecipient {
  userId: string;
  email: string;
  name: string | null;
  items: DigestItem[];
}

interface PendingRow {
  subscriber_user_id: string;
  user_email: string;
  user_name: string | null;
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  channel_username: string | null;
  added_at: string;
}

const MAX_ITEMS_PER_DIGEST = 25;
const PENDING_FETCH_LIMIT = 5_000;

export function groupItemsByRecipient(rows: readonly PendingRow[]): DigestRecipient[] {
  const byUser = new Map<string, DigestRecipient>();
  for (const r of rows) {
    if (!r.user_email) continue;
    let entry = byUser.get(r.subscriber_user_id);
    if (!entry) {
      entry = {
        userId: r.subscriber_user_id,
        email: r.user_email,
        name: r.user_name,
        items: [],
      };
      byUser.set(r.subscriber_user_id, entry);
    }
    if (entry.items.length >= MAX_ITEMS_PER_DIGEST) continue;
    entry.items.push({
      videoId: r.video_id,
      title: r.title,
      thumbnailUrl: r.thumbnail_url,
      channelName: r.channel_name ?? 'Unknown channel',
      channelUsername: r.channel_username,
      addedAt: r.added_at,
    });
  }
  return Array.from(byUser.values());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInboxDigestEmail(args: {
  recipient: DigestRecipient;
  origin: string;
}): { subject: string; html: string } {
  const { recipient, origin } = args;
  const count = recipient.items.length;
  const subject =
    count === 1
      ? `New on spooool: ${recipient.items[0].title}`
      : `${count} new videos from creators you follow on spooool`;

  const greetingName = recipient.name ? recipient.name.split(/\s+/, 1)[0] : null;
  const greeting = greetingName ? `Hi ${escapeHtml(greetingName)},` : 'Hi,';

  const itemHtml = recipient.items
    .map((item) => {
      const watchUrl = `${origin}/watch/${encodeURIComponent(item.videoId)}`;
      const channelUrl = item.channelUsername
        ? `${origin}/channel/${encodeURIComponent(item.channelUsername)}`
        : null;
      const thumbnail = item.thumbnailUrl
        ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="" width="320" style="display:block;border-radius:8px;max-width:100%;height:auto;" />`
        : '';
      const channelLine = channelUrl
        ? `<a href="${escapeHtml(channelUrl)}" style="color:#666;text-decoration:none;">${escapeHtml(item.channelName)}</a>`
        : escapeHtml(item.channelName);
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee;">
  <a href="${escapeHtml(watchUrl)}" style="color:#111;text-decoration:none;font-weight:600;">${escapeHtml(item.title)}</a>
  <div style="color:#666;font-size:13px;margin:4px 0 8px;">${channelLine}</div>
  ${thumbnail}
</td></tr>`;
    })
    .join('\n');

  const inboxUrl = `${origin}/inbox`;
  const html = `<p>${greeting}</p>
<p>Here's what's new from creators you follow on spooool:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;">
${itemHtml}
</table>
<p style="margin-top:20px;"><a href="${escapeHtml(inboxUrl)}" style="color:#111;">Open your inbox</a></p>
<p style="color:#888;font-size:12px;margin-top:20px;">You're getting this because you subscribed to one or more creators on spooool. Manage your subscriptions in your <a href="${escapeHtml(origin)}/profile">profile</a>.</p>`;

  return { subject, html };
}

async function fetchPendingRows(env: InboxDigestEnv): Promise<PendingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.subscriber_user_id, u.email AS user_email, u.name AS user_name,
            i.video_id, v.title, v.thumbnail_url, i.added_at,
            ch.name AS channel_name, ch.username AS channel_username
     FROM subscription_inbox i
     JOIN user u ON u.id = i.subscriber_user_id
     JOIN videos v ON v.id = i.video_id AND v.deleted_at IS NULL AND v.hidden_at IS NULL
     LEFT JOIN user ch ON ch.id = i.channel_user_id
     WHERE i.seen_at IS NULL AND i.digest_sent_at IS NULL
     ORDER BY i.subscriber_user_id, i.added_at DESC
     LIMIT ?`,
  )
    .bind(PENDING_FETCH_LIMIT)
    .all<PendingRow>();
  return results ?? [];
}

async function markItemsSent(
  env: InboxDigestEnv,
  recipient: DigestRecipient,
  now: string,
): Promise<void> {
  if (recipient.items.length === 0) return;
  const placeholders = recipient.items.map(() => '?').join(',');
  const stmt = env.DB.prepare(
    `UPDATE subscription_inbox
     SET digest_sent_at = ?
     WHERE subscriber_user_id = ?
       AND video_id IN (${placeholders})
       AND seen_at IS NULL`,
  );
  await stmt
    .bind(now, recipient.userId, ...recipient.items.map((i) => i.videoId))
    .run();
}

export interface DigestRunStats {
  recipients: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runInboxDigestSweep(env: InboxDigestEnv): Promise<DigestRunStats> {
  const stats: DigestRunStats = { recipients: 0, sent: 0, skipped: 0, failed: 0 };

  if (!env.RESEND_API_KEY) {
    return stats;
  }

  const rows = await fetchPendingRows(env);
  const recipients = groupItemsByRecipient(rows);
  stats.recipients = recipients.length;

  if (recipients.length === 0) return stats;

  const origin = (env.BETTER_AUTH_URL ?? 'https://spooool.com').replace(/\/+$/, '');
  const now = new Date().toISOString();

  for (const recipient of recipients) {
    if (recipient.items.length === 0) {
      stats.skipped += 1;
      continue;
    }
    const { subject, html } = renderInboxDigestEmail({ recipient, origin });
    const result = await sendEmail(env, {
      to: recipient.email,
      subject,
      html,
    });
    if (result.ok) {
      try {
        await markItemsSent(env, recipient, now);
        stats.sent += 1;
      } catch (err) {
        console.warn('inbox-digest: failed to stamp digest_sent_at', {
          userId: recipient.userId,
          error: err instanceof Error ? err.message : String(err),
        });
        stats.failed += 1;
      }
    } else if (result.skipped) {
      stats.skipped += 1;
    } else {
      console.warn('inbox-digest: Resend rejected delivery', {
        userId: recipient.userId,
        status: result.status,
        message: result.message,
      });
      stats.failed += 1;
    }
  }

  return stats;
}
