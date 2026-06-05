import { Hono } from 'hono';
import { z } from 'zod';
import { createAuth, type AuthEnv } from '../auth';
import { getStorageUsage } from './storage-quota';

export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface AccountEnv extends AuthEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  VIDEOS: R2Bucket;
}

type SessionUser = { id: string; email: string; name: string } | null;
type AccountVariables = { user: SessionUser };

const emailUpdateSchema = z.object({
  email: z.string().email().max(254),
});

const passwordUpdateSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(8).max(200),
});

const notificationPrefsSchema = z.object({
  notifyEmailNewUpload: z.boolean(),
  notifyEmailComments: z.boolean(),
});

export const accountRoutes = new Hono<{
  Bindings: AccountEnv;
  Variables: AccountVariables;
}>();

accountRoutes.get('/api/account', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [row, storage] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, email, name, deletion_requested_at, deletion_scheduled_for,
              notify_email_new_upload, notify_email_comments
       FROM user WHERE id = ?`,
    )
      .bind(user.id)
      .first<{
        id: string;
        email: string;
        name: string;
        deletion_requested_at: number | null;
        deletion_scheduled_for: number | null;
        notify_email_new_upload: number;
        notify_email_comments: number;
      }>(),
    // ALO-139: surface the user's quota + current usage so the account
    // settings page (and any future creator dashboard) can render a
    // progress bar without an extra round trip.
    getStorageUsage(c.env, user.id),
  ]);
  if (!row) return c.json({ error: 'User not found' }, 404);

  return c.json({
    id: row.id,
    email: row.email,
    name: row.name,
    deletionRequestedAt: row.deletion_requested_at,
    deletionScheduledFor: row.deletion_scheduled_for,
    notifyEmailNewUpload: row.notify_email_new_upload !== 0,
    notifyEmailComments: row.notify_email_comments !== 0,
    storage,
  });
});

accountRoutes.put('/api/account/email', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = emailUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid email', details: parsed.error.flatten() }, 400);
  }

  const taken = await c.env.DB.prepare('SELECT id FROM user WHERE email = ? AND id != ?')
    .bind(parsed.data.email, user.id)
    .first();
  if (taken) return c.json({ error: 'Email already in use' }, 409);

  await c.env.DB.prepare('UPDATE user SET email = ?, updatedAt = ? WHERE id = ?')
    .bind(parsed.data.email, Date.now(), user.id)
    .run();

  return c.json({ id: user.id, email: parsed.data.email });
});

accountRoutes.put('/api/account/password', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = passwordUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid password', details: parsed.error.flatten() }, 400);
  }

  // Delegate to better-auth so we don't duplicate password hashing/verification.
  const auth = createAuth(c.env);
  try {
    await auth.api.changePassword({
      headers: c.req.raw.headers,
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Password change failed' }, 400);
  }
  return c.json({ ok: true });
});

accountRoutes.put('/api/account/notifications', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = notificationPrefsSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid preferences', details: parsed.error.flatten() }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE user
     SET notify_email_new_upload = ?, notify_email_comments = ?, updatedAt = ?
     WHERE id = ?`,
  )
    .bind(
      parsed.data.notifyEmailNewUpload ? 1 : 0,
      parsed.data.notifyEmailComments ? 1 : 0,
      Date.now(),
      user.id,
    )
    .run();

  return c.json({
    notifyEmailNewUpload: parsed.data.notifyEmailNewUpload,
    notifyEmailComments: parsed.data.notifyEmailComments,
  });
});

accountRoutes.post('/api/account/delete', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const now = Date.now();
  const scheduledFor = now + DELETION_GRACE_MS;

  await c.env.DB.prepare(
    `UPDATE user
     SET deletion_requested_at = ?, deletion_scheduled_for = ?, updatedAt = ?
     WHERE id = ?`,
  )
    .bind(now, scheduledFor, now, user.id)
    .run();

  // LEGAL-REVIEW: replace placeholder confirmation email body with
  // counsel-approved GDPR text before going to production. We log to a console
  // sink today; once an email provider lands (ALO-???), wire this into it.
  console.log('[account-delete] scheduled', {
    userId: user.id,
    scheduledFor: new Date(scheduledFor).toISOString(),
    template: 'account-deletion-requested',
    placeholder: true,
  });

  return c.json({
    deletionRequestedAt: now,
    deletionScheduledFor: scheduledFor,
    graceDays: DELETION_GRACE_DAYS,
  });
});

// GET /api/account/earnings — returns the creator's payout summary for the
// current calendar year.  Numbers are null until the Polar payout webhook
// integration lands (ALO-partner-tax gap): Polar is MoR for sales-tax/VAT but
// does not yet issue 1099-K / 1099-MISC for US creator partners.  The
// `taxDocStatus` field drives the gap banner in AccountSettings.
accountRoutes.get('/api/account/earnings', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // ALO-TODO: replace with real Polar payout webhook aggregation once the
  // partner-payout integration is live.  Until then we return the correct
  // shape with null values so the UI can render the gap banner.
  const year = new Date().getUTCFullYear();
  return c.json({
    year,
    currency: 'USD',
    // Gross earnings before Spooool's 10% platform fee and Polar processing fees.
    grossEarningsUsd: null as number | null,
    // Net creator payout — what Polar actually transfers to the creator's bank.
    netPayoutsUsd: null as number | null,
    // 'polar-pending' = Polar has not yet issued 1099 forms for creator partners.
    // Update to 'polar-issues' once Polar confirms 1099-K / 1099-MISC delivery.
    taxDocStatus: 'polar-pending' as 'polar-pending' | 'polar-issues',
  });
});

accountRoutes.post('/api/account/delete/cancel', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    'SELECT deletion_scheduled_for FROM user WHERE id = ?',
  )
    .bind(user.id)
    .first<{ deletion_scheduled_for: number | null }>();
  if (!row) return c.json({ error: 'User not found' }, 404);
  if (!row.deletion_scheduled_for) {
    return c.json({ error: 'No deletion scheduled' }, 400);
  }
  if (row.deletion_scheduled_for <= Date.now()) {
    return c.json({ error: 'Grace window has expired' }, 410);
  }

  await c.env.DB.prepare(
    `UPDATE user
     SET deletion_requested_at = NULL, deletion_scheduled_for = NULL, updatedAt = ?
     WHERE id = ?`,
  )
    .bind(Date.now(), user.id)
    .run();
  return c.json({ ok: true });
});

export interface CascadeEnv {
  DB: D1Database;
  VIDEOS: R2Bucket;
  CACHE: KVNamespace;
}

export interface CascadeStats {
  userId: string;
  videosDeleted: number;
  commentsAnonymized: number;
  subscriptionsDeleted: number;
  sessionsDeleted: number;
}

// Cascade hard-delete for one user. Wrapped in `batch()` so D1 runs the
// statements in a single implicit transaction. R2 deletes happen first because
// they can't roll back; if D1 fails we'd rather have orphaned R2 keys than a
// partial DB delete.
export async function cascadeDeleteUser(env: CascadeEnv, userId: string): Promise<CascadeStats> {
  const videos = await env.DB.prepare(
    'SELECT id, r2_key FROM videos WHERE user_id = ?',
  )
    .bind(userId)
    .all<{ id: string; r2_key: string }>();
  const videoRows = videos.results ?? [];

  await Promise.all(
    videoRows.map(async (v) => {
      await env.VIDEOS.delete(v.r2_key).catch(() => {});
      await env.CACHE.delete(`video:v1:${v.id}`).catch(() => {});
    }),
  );

  const stmts = [
    env.DB.prepare(
      `UPDATE comments SET user_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    ).bind(userId),
    env.DB.prepare(`DELETE FROM views WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM videos WHERE user_id = ?`).bind(userId),
    env.DB.prepare(
      `DELETE FROM subscriptions
       WHERE subscriber_user_id = ? OR channel_user_id = ?`,
    ).bind(userId, userId),
    env.DB.prepare(`DELETE FROM session WHERE userId = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM account WHERE userId = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(userId),
  ];
  await env.DB.batch(stmts);

  return {
    userId,
    videosDeleted: videoRows.length,
    commentsAnonymized: 0,
    subscriptionsDeleted: 0,
    sessionsDeleted: 0,
  };
}

// Sweep all users whose grace window has elapsed.
export async function runDeletionSweep(env: CascadeEnv, nowMs = Date.now()): Promise<CascadeStats[]> {
  const due = await env.DB.prepare(
    `SELECT id FROM user
     WHERE deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= ?`,
  )
    .bind(nowMs)
    .all<{ id: string }>();
  const out: CascadeStats[] = [];
  for (const row of due.results ?? []) {
    out.push(await cascadeDeleteUser(env, row.id));
  }
  return out;
}
