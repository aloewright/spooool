// ALO-157: transactional notification email helpers (new upload, comments, digest).
// Fail-open — email failures never block the calling request path.

import { send, type EmailEnv, type EmailResult } from './email';
import { generateUnsubToken } from './account';

export interface NotificationDbEnv extends EmailEnv {
  DB: D1Database;
  EMAIL_UNSUBSCRIBE_SECRET?: string;
}

export function buildNewUploadEmail(args: {
  channelName: string;
  videoTitle: string;
  watchUrl: string;
  unsubscribeUrl?: string;
}): { subject: string; html: string; text: string } {
  const unsubLine = args.unsubscribeUrl
    ? `\n\nUnsubscribe from new upload emails: ${args.unsubscribeUrl}`
    : '\n\nManage notification preferences in your account settings.';
  const unsubHtml = args.unsubscribeUrl
    ? `<p style="font-size:12px;color:#666"><a href="${args.unsubscribeUrl}">Unsubscribe</a> from new upload emails.</p>`
    : `<p style="font-size:12px;color:#666">Manage notification preferences in account settings.</p>`;
  return {
    subject: `${args.channelName} uploaded a new video`,
    text:
      `${args.channelName} just uploaded "${args.videoTitle}".\n\n` +
      `Watch it here: ${args.watchUrl}` +
      unsubLine,
    html:
      `<p><strong>${escapeHtml(args.channelName)}</strong> just uploaded ` +
      `<em>${escapeHtml(args.videoTitle)}</em>.</p>` +
      `<p><a href="${args.watchUrl}">Watch now</a></p>` +
      unsubHtml,
  };
}

export function buildCommentEmail(args: {
  commenterName: string;
  videoTitle: string;
  watchUrl: string;
  excerpt: string;
  unsubscribeUrl?: string;
}): { subject: string; html: string; text: string } {
  const unsubLine = args.unsubscribeUrl
    ? `\n\nUnsubscribe from comment emails: ${args.unsubscribeUrl}`
    : '';
  const unsubHtml = args.unsubscribeUrl
    ? `<p style="font-size:12px;color:#666"><a href="${args.unsubscribeUrl}">Unsubscribe</a> from comment emails.</p>`
    : '';
  return {
    subject: `New comment on "${args.videoTitle}"`,
    text:
      `${args.commenterName} commented on your video "${args.videoTitle}":\n` +
      `${args.excerpt}\n\nWatch: ${args.watchUrl}` +
      unsubLine,
    html:
      `<p><strong>${escapeHtml(args.commenterName)}</strong> commented on ` +
      `<em>${escapeHtml(args.videoTitle)}</em>:</p>` +
      `<blockquote>${escapeHtml(args.excerpt)}</blockquote>` +
      `<p><a href="${args.watchUrl}">View comment</a></p>` +
      unsubHtml,
  };
}

export function buildDigestEmail(args: {
  items: Array<{ channelName: string; videoTitle: string; watchUrl: string }>;
}): { subject: string; html: string; text: string } {
  const lines = args.items.map(
    (i) => `• ${i.channelName}: ${i.videoTitle} — ${i.watchUrl}`,
  );
  const htmlRows = args.items
    .map(
      (i) =>
        `<li><strong>${escapeHtml(i.channelName)}</strong>: ` +
        `<a href="${i.watchUrl}">${escapeHtml(i.videoTitle)}</a></li>`,
    )
    .join('');
  return {
    subject: `Your Spooool subscription digest (${args.items.length} new uploads)`,
    text:
      `New uploads from channels you follow:\n\n${lines.join('\n')}\n\n` +
      `Manage notification preferences in account settings.`,
    html:
      `<p>New uploads from channels you follow:</p><ul>${htmlRows}</ul>` +
      `<p style="font-size:12px;color:#666">Manage notification preferences in account settings.</p>`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Send in parallel but bounded — unbounded Promise.all over many subscribers
// can exhaust the Worker's simultaneous-connection / subrequest budget.
const EMAIL_SEND_CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function sendNewUploadEmails(
  env: NotificationDbEnv,
  args: { videoId: string; channelUserId: string; channelName: string; videoTitle: string; origin: string },
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email
     FROM subscriptions s
     JOIN user u ON u.id = s.subscriber_user_id
     WHERE s.channel_user_id = ?
       AND u.notify_email_new_upload = 1
       AND u.email IS NOT NULL`,
  )
    .bind(args.channelUserId)
    .all<{ id: string; email: string }>();

  const origin = args.origin.replace(/\/$/, '');
  const watchUrl = `${origin}/watch/${args.videoId}`;
  const secret = env.EMAIL_UNSUBSCRIBE_SECRET;

  const sendResults = await mapWithConcurrency(
    results ?? [],
    EMAIL_SEND_CONCURRENCY,
    async (row) => {
      let unsubscribeUrl: string | undefined;
      if (secret) {
        const tok = await generateUnsubToken(secret, row.id, 'uploads');
        unsubscribeUrl = `${origin}/api/account/unsubscribe?uid=${encodeURIComponent(row.id)}&tok=${tok}&pref=uploads`;
      }
      const template = buildNewUploadEmail({
        channelName: args.channelName,
        videoTitle: args.videoTitle,
        watchUrl,
        unsubscribeUrl,
      });
      return send(env, { to: row.email, ...template });
    },
  );
  return sendResults.filter((r) => r.ok).length;
}

export async function sendCommentNotificationEmail(
  env: NotificationDbEnv,
  args: {
    ownerUserId: string;
    commenterName: string;
    videoId: string;
    videoTitle: string;
    excerpt: string;
    origin: string;
  },
): Promise<EmailResult | { ok: false; skipped: true; reason: string }> {
  const owner = await env.DB.prepare(
    `SELECT email, notify_email_comments FROM user WHERE id = ?`,
  )
    .bind(args.ownerUserId)
    .first<{ email: string; notify_email_comments: number }>();

  if (!owner?.email || owner.notify_email_comments === 0) {
    return { ok: false, skipped: true, reason: 'comments email disabled' };
  }

  const origin = args.origin.replace(/\/$/, '');
  const watchUrl = `${origin}/watch/${args.videoId}`;
  const secret = env.EMAIL_UNSUBSCRIBE_SECRET;
  let unsubscribeUrl: string | undefined;
  if (secret) {
    const tok = await generateUnsubToken(secret, args.ownerUserId, 'comments');
    unsubscribeUrl = `${origin}/api/account/unsubscribe?uid=${encodeURIComponent(args.ownerUserId)}&tok=${tok}&pref=comments`;
  }

  return send(env, {
    to: owner.email,
    ...buildCommentEmail({
      commenterName: args.commenterName,
      videoTitle: args.videoTitle,
      watchUrl,
      excerpt: args.excerpt.slice(0, 280),
      unsubscribeUrl,
    }),
  });
}

/** Daily digest: email subscribers about inbox items from the last 24 hours. */
export async function runEmailDigestSweep(env: NotificationDbEnv): Promise<{ users: number; sent: number }> {
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, u.email,
            v.id AS video_id, v.title AS video_title,
            ch.name AS channel_name
     FROM subscription_inbox i
     JOIN user u ON u.id = i.subscriber_user_id
     JOIN videos v ON v.id = i.video_id AND v.deleted_at IS NULL
     LEFT JOIN user ch ON ch.id = i.channel_user_id
     WHERE u.notify_email_new_upload = 1
       AND u.email IS NOT NULL
       AND i.added_at >= datetime('now', '-1 day')
     ORDER BY u.id, i.added_at DESC`,
  ).all<{
    user_id: string;
    email: string;
    video_id: string;
    video_title: string;
    channel_name: string | null;
  }>();

  const byUser = new Map<string, { email: string; items: Array<{ channelName: string; videoTitle: string; watchUrl: string }> }>();
  const origin = 'https://spooool.com';

  for (const row of results ?? []) {
    const bucket = byUser.get(row.user_id) ?? { email: row.email, items: [] };
    bucket.items.push({
      channelName: row.channel_name ?? 'A channel',
      videoTitle: row.video_title,
      watchUrl: `${origin}/watch/${row.video_id}`,
    });
    byUser.set(row.user_id, bucket);
  }

  const digests = Array.from(byUser.values()).filter(({ items }) => items.length > 0);
  const sendResults = await mapWithConcurrency(
    digests,
    EMAIL_SEND_CONCURRENCY,
    ({ email, items }) =>
      send(env, { to: email, ...buildDigestEmail({ items: items.slice(0, 20) }) }),
  );
  const sent = sendResults.filter((r) => r.ok).length;

  return { users: byUser.size, sent };
}
