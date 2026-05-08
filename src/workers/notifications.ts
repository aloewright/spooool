// ALO-157: notifications routes — in-app bell unread count + email digest
// preferences. The bell badge is backed by `subscription_inbox.seen_at` (the
// existing ALO-156 fan-out table); we just expose a count + a list endpoint
// alongside the inbox routes in subscriptions.ts.
//
// Email digest preferences live on the user row (see migration 0019). The
// digest cron sweep itself lives in ./digest.ts and reads these columns.

import { Hono } from 'hono';
import { z } from 'zod';

export const DIGEST_FREQUENCIES = ['off', 'daily', 'weekly'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export interface NotificationsEnv {
  DB: D1Database;
}

type SessionUser = { id: string } | null;
type NotificationsVariables = { user: SessionUser };

// Cap so the badge stays compact in the header. Anything above this renders
// as e.g. "99+" client-side; we still return the truncated number.
export const UNREAD_BADGE_CAP = 99;

const preferencesSchema = z.object({
  emailDigestFrequency: z.enum(DIGEST_FREQUENCIES),
});

export const notificationRoutes = new Hono<{
  Bindings: NotificationsEnv;
  Variables: NotificationsVariables;
}>();

notificationRoutes.get('/api/users/me/notifications/unread-count', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // Cap the COUNT(*) in SQL so a user with 10k unseen items doesn't pay for
  // a full table scan every header poll.
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT 1 FROM subscription_inbox
       WHERE subscriber_user_id = ? AND seen_at IS NULL
       LIMIT ?
     )`,
  )
    .bind(user.id, UNREAD_BADGE_CAP + 1)
    .first<{ c: number }>();

  const count = Math.min(Number(row?.c ?? 0), UNREAD_BADGE_CAP + 1);
  return c.json({ unread: count, capped: count > UNREAD_BADGE_CAP });
});

notificationRoutes.get('/api/users/me/notifications/preferences', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT email_digest_frequency, email_digest_last_sent_at
     FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<{ email_digest_frequency: DigestFrequency; email_digest_last_sent_at: number | null }>();
  if (!row) return c.json({ error: 'User not found' }, 404);

  return c.json({
    emailDigestFrequency: row.email_digest_frequency,
    emailDigestLastSentAt: row.email_digest_last_sent_at,
  });
});

notificationRoutes.put('/api/users/me/notifications/preferences', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = preferencesSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid preferences', details: parsed.error.flatten() }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE user SET email_digest_frequency = ?, updatedAt = ? WHERE id = ?`,
  )
    .bind(parsed.data.emailDigestFrequency, Date.now(), user.id)
    .run();

  return c.json({ emailDigestFrequency: parsed.data.emailDigestFrequency });
});
