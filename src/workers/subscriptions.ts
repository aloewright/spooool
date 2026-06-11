import { Hono } from 'hono';
import { z } from 'zod';

export interface SubscriptionsEnv {
  DB: D1Database;
}

type SessionUser = { id: string } | null;
type SubscriptionsVariables = { user: SessionUser };

const inboxQuerySchema = z.object({
  unseenOnly: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  page: z.coerce.number().int().positive().default(1),
});

async function findChannelByUsername(
  db: D1Database,
  username: string,
): Promise<{ id: string } | null> {
  return db
    .prepare('SELECT id FROM user WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();
}

export const subscriptionRoutes = new Hono<{
  Bindings: SubscriptionsEnv;
  Variables: SubscriptionsVariables;
}>();

subscriptionRoutes.get('/api/channels/:username/subscription', async (c) => {
  const username = c.req.param('username');
  const user = c.get('user');

  // Single JOIN collapses 2-3 sequential round-trips into one:
  //   1. username → channel id  2. subscriber count  3. is-subscribed check
  // NULL subscriber_user_id (unauthenticated) never matches any row, so
  // is_subscribed safely returns 0 without branching.
  const row = await c.env.DB.prepare(
    `SELECT u.id AS channel_id,
            COUNT(s.id) AS subscriber_count,
            COALESCE(MAX(CASE WHEN s.subscriber_user_id = ? THEN 1 ELSE 0 END), 0) AS is_subscribed
     FROM user u
     LEFT JOIN subscriptions s ON s.channel_user_id = u.id
     WHERE u.username = ?
     GROUP BY u.id`,
  )
    .bind(user?.id ?? null, username)
    .first<{ channel_id: string; subscriber_count: number; is_subscribed: number }>();

  if (!row) return c.json({ error: 'Channel not found' }, 404);
  return c.json({
    subscribed: row.is_subscribed !== 0,
    subscriberCount: Number(row.subscriber_count ?? 0),
  });
});

subscriptionRoutes.post('/api/channels/:username/subscribe', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (channel.id === user.id) {
    return c.json({ error: 'Cannot subscribe to your own channel' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO subscriptions (id, subscriber_user_id, channel_user_id)
     VALUES (?, ?, ?)
     ON CONFLICT(subscriber_user_id, channel_user_id) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), user.id, channel.id)
    .run();

  return c.json({ subscribed: true });
});

subscriptionRoutes.delete('/api/channels/:username/subscribe', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  await c.env.DB.prepare(
    'DELETE FROM subscriptions WHERE subscriber_user_id = ? AND channel_user_id = ?',
  )
    .bind(user.id, channel.id)
    .run();

  return c.json({ subscribed: false });
});

subscriptionRoutes.get('/api/users/me/subscriptions', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.displayName, u.name, u.avatarUrl, s.created_at AS subscribed_at
     FROM subscriptions s
     JOIN user u ON u.id = s.channel_user_id
     WHERE s.subscriber_user_id = ?
     ORDER BY s.created_at DESC`,
  )
    .bind(user.id)
    .all();
  return c.json({ subscriptions: results });
});

subscriptionRoutes.get('/api/users/me/inbox/unread-count', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM subscription_inbox
     WHERE subscriber_user_id = ? AND seen_at IS NULL`,
  )
    .bind(user.id)
    .first<{ count: number }>();

  return c.json({ count: Number(row?.count ?? 0) });
});

subscriptionRoutes.get('/api/users/me/inbox', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = inboxQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const { unseenOnly, limit, page } = parsed.data;
  const offset = (page - 1) * limit;
  const onlyUnseen = unseenOnly === '1' || unseenOnly === 'true';

  const { results } = await c.env.DB.prepare(
    `SELECT i.video_id, i.channel_user_id, i.added_at, i.seen_at,
            v.title, v.thumbnail_url, v.created_at AS video_created_at,
            u.name AS channel_name, u.username AS channel_username
     FROM subscription_inbox i
     JOIN videos v ON v.id = i.video_id AND v.deleted_at IS NULL
     LEFT JOIN user u ON u.id = i.channel_user_id
     WHERE i.subscriber_user_id = ?
       AND (? = 0 OR i.seen_at IS NULL)
     ORDER BY i.added_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(user.id, onlyUnseen ? 1 : 0, limit, offset)
    .all();

  return c.json({ items: results, page, limit, unseenOnly: onlyUnseen });
});

subscriptionRoutes.post('/api/users/me/inbox/seen', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  await c.env.DB.prepare(
    `UPDATE subscription_inbox
     SET seen_at = CURRENT_TIMESTAMP
     WHERE subscriber_user_id = ? AND seen_at IS NULL`,
  )
    .bind(user.id)
    .run();
  return c.json({ ok: true });
});
