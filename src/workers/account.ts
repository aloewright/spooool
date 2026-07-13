import { Hono } from 'hono';
import { z } from 'zod';
import { createAuth, type AuthEnv } from '../auth';
import { getStorageUsage } from './storage-quota';
import { sendAccountDeletionEmail } from './email';

export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface AccountEnv extends AuthEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  VIDEOS: R2Bucket;
  POLAR_CLIENT_ID?: string;
  POLAR_CLIENT_SECRET?: string;
  EMAIL_UNSUBSCRIBE_SECRET?: string;
}

// HMAC-SHA256 over "unsub:<userId>:<pref>" — stateless, no DB column needed.
// The secret is an optional Worker secret; if absent, unsubscribe links are
// omitted from emails (graceful degradation).
export async function generateUnsubToken(secret: string, userId: string, pref: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`unsub:${userId}:${pref}`));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function verifyUnsubToken(secret: string, userId: string, pref: string, token: string): Promise<boolean> {
  const expected = await generateUnsubToken(secret, userId, pref);
  if (expected.length !== token.length) return false;
  // Constant-time compare
  const enc = new TextEncoder();
  const a = enc.encode(expected);
  const b = enc.encode(token);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
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

  const deletionDate = new Date(scheduledFor).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const origin = new URL(c.req.url).origin;
  const emailResult = await sendAccountDeletionEmail(c.env, {
    to: user.email,
    name: user.name,
    deletionDate,
    cancelUrl: `${origin}/settings`,
  });
  if (!emailResult.ok) {
    console.warn('[account-delete] deletion email not sent', { userId: user.id, emailResult });
  }

  return c.json({
    deletionRequestedAt: now,
    deletionScheduledFor: scheduledFor,
    graceDays: DELETION_GRACE_DAYS,
  });
});

// ---------------------------------------------------------------------------
// Polar partner onboarding — OAuth connect flow + payout status
// ---------------------------------------------------------------------------

const POLAR_API_BASE = 'https://api.polar.sh';
const POLAR_OAUTH_BASE = 'https://polar.sh';

type PolarAccountStatus = 'not_connected' | 'pending' | 'active' | 'under_review';

interface PolarOrganization {
  id: string;
  name: string;
  slug: string;
}

interface PolarPayoutAccount {
  id: string;
  account_type: string;
  status: 'created' | 'onboarding_started' | 'onboarding_succeeded' | 'active' | 'under_review' | 'suspended';
}

async function resolvePolarAccount(
  accessToken: string,
): Promise<{ status: PolarAccountStatus; accountId: string | null }> {
  try {
    const res = await fetch(`${POLAR_API_BASE}/v1/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { status: 'pending', accountId: null };
    const data = await res.json() as { items?: PolarPayoutAccount[] };
    const accounts = data.items ?? [];
    // Capture the payout account's id so the Polar payout webhook (which keys on
    // data.account_id) can match this user — the webhook never receives our
    // organization id. The id is the same for any lifecycle status, so prefer
    // the first account regardless of status.
    const accountId = accounts[0]?.id ?? null;
    if (accounts.some((a) => a.status === 'active')) return { status: 'active', accountId };
    if (accounts.some((a) => a.status === 'under_review')) return { status: 'under_review', accountId };
    return { status: 'pending', accountId };
  } catch {
    return { status: 'pending', accountId: null };
  }
}

// Initiates the Polar OAuth connect flow for the logged-in creator. Stores a
// short-lived state token in KV to guard against CSRF on the callback.
accountRoutes.get('/api/account/polar/connect', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const clientId = c.env.POLAR_CLIENT_ID;
  if (!clientId) return c.json({ error: 'Polar OAuth not configured' }, 503);

  const stateToken = crypto.randomUUID();
  await c.env.CACHE.put(`polar:oauth:${stateToken}`, user.id, { expirationTtl: 600 });

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/account/polar/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid organizations:read accounts:read',
    state: stateToken,
  });

  return c.redirect(`${POLAR_OAUTH_BASE}/oauth2/authorize?${params}`);
});

// Handles the OAuth callback: exchanges the code, fetches the creator's Polar
// org ID and payout account status, and persists both on the user row.
accountRoutes.get('/api/account/polar/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const oauthError = c.req.query('error');

  if (oauthError) {
    console.warn('[polar-partner] oauth denied', { oauthError });
    return c.redirect(`/settings?polar_error=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) {
    return c.redirect('/settings?polar_error=missing_params');
  }

  const userId = await c.env.CACHE.get(`polar:oauth:${state}`);
  if (!userId) {
    return c.redirect('/settings?polar_error=invalid_state');
  }
  await c.env.CACHE.delete(`polar:oauth:${state}`);

  const clientId = c.env.POLAR_CLIENT_ID;
  const clientSecret = c.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.redirect('/settings?polar_error=not_configured');
  }

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/api/account/polar/callback`;

  // Exchange authorization code for access token.
  const tokenRes = await fetch(`${POLAR_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    console.error('[polar-partner] token exchange failed', { status: tokenRes.status });
    return c.redirect('/settings?polar_error=token_exchange_failed');
  }

  const { access_token: accessToken } = await tokenRes.json() as { access_token: string };

  // Fetch the creator's Polar organization (first org = the creator's own).
  const orgsRes = await fetch(`${POLAR_API_BASE}/v1/organizations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!orgsRes.ok) {
    console.error('[polar-partner] orgs fetch failed', { status: orgsRes.status });
    return c.redirect('/settings?polar_error=orgs_fetch_failed');
  }

  const orgsData = await orgsRes.json() as { items?: PolarOrganization[] };
  const org = orgsData.items?.[0];
  if (!org) {
    return c.redirect('/settings?polar_error=no_organization');
  }

  const { status: accountStatus, accountId } = await resolvePolarAccount(accessToken);

  await c.env.DB.prepare(
    `UPDATE user SET polar_organization_id = ?, polar_account_id = ?, polar_account_status = ?, updatedAt = ? WHERE id = ?`,
  )
    .bind(org.id, accountId, accountStatus, Date.now(), userId)
    .run();

  console.log('[polar-partner] connected', { userId, orgId: org.id, accountId, accountStatus });

  return c.redirect('/settings?polar_connected=1');
});

// Returns the current Polar partner status for the logged-in creator.
accountRoutes.get('/api/account/polar/status', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT polar_organization_id, polar_account_status FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<{ polar_organization_id: string | null; polar_account_status: string }>();

  if (!row) return c.json({ error: 'User not found' }, 404);

  const status = (row.polar_account_status ?? 'not_connected') as PolarAccountStatus;
  return c.json({
    organizationId: row.polar_organization_id,
    status,
    needsOnboarding: status !== 'active',
  });
});

// GET /api/account/earnings — returns the creator's YTD earnings summary.
// Polar is MoR for sales-tax/VAT but does not yet issue 1099-K / 1099-MISC
// for US creator partners.  The `taxDocStatus` field drives the gap banner in
// AccountSettings.
accountRoutes.get('/api/account/earnings', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT polar_organization_id, polar_account_status FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<{ polar_organization_id: string | null; polar_account_status: string }>();

  const polarStatus = (row?.polar_account_status ?? 'not_connected') as PolarAccountStatus;

  const year = new Date().getUTCFullYear();
  // creator_earnings.created_at is stored as ms-epoch integers (written by the
  // Polar webhook handler). CAST ensures numeric comparison even though the
  // column was declared as TEXT.
  const yearStartMs = Date.UTC(year, 0, 1);
  const yearEndMs = Date.UTC(year + 1, 0, 1);

  const [earningsRow, payoutsRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS gross
       FROM creator_earnings
       WHERE user_id = ?
         AND CAST(created_at AS INTEGER) >= ?
         AND CAST(created_at AS INTEGER) < ?`,
    )
      .bind(user.id, yearStartMs, yearEndMs)
      .first<{ gross: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS net
       FROM creator_payouts
       WHERE user_id = ?
         AND status = 'paid'
         AND CAST(created_at AS INTEGER) >= ?
         AND CAST(created_at AS INTEGER) < ?`,
    )
      .bind(user.id, yearStartMs, yearEndMs)
      .first<{ net: number }>(),
  ]);

  const grossCents = Number(earningsRow?.gross ?? 0);
  const netCents = Number(payoutsRow?.net ?? 0);

  return c.json({
    year,
    currency: 'USD',
    grossEarningsUsd: grossCents / 100,
    netPayoutsUsd: netCents / 100,
    // 'polar-pending' = Polar has not yet issued 1099 forms for creator partners.
    // Update to 'polar-issues' once Polar confirms 1099-K / 1099-MISC delivery.
    taxDocStatus: 'polar-pending' as 'polar-pending' | 'polar-issues',
    polar: {
      organizationId: row?.polar_organization_id ?? null,
      accountStatus: polarStatus,
      needsOnboarding: polarStatus !== 'active',
    },
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

// One-click unsubscribe — linked from notification emails so the recipient
// can opt out without having to log in. Uses a stateless HMAC token scoped
// to the userId + preference type so tokens can't be used cross-account.
accountRoutes.get('/api/account/unsubscribe', async (c) => {
  const secret = c.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!secret) return c.json({ error: 'Unsubscribe not configured' }, 501);

  const uid = c.req.query('uid');
  const tok = c.req.query('tok');
  const pref = c.req.query('pref');

  if (!uid || !tok || !pref || !['uploads', 'comments'].includes(pref)) {
    return c.json({ error: 'Invalid unsubscribe link' }, 400);
  }

  const valid = await verifyUnsubToken(secret, uid, pref, tok);
  if (!valid) return c.json({ error: 'Invalid or expired token' }, 400);

  const col = pref === 'uploads' ? 'notify_email_new_upload' : 'notify_email_comments';
  const result = await c.env.DB.prepare(
    `UPDATE user SET ${col} = 0, updatedAt = ? WHERE id = ?`,
  )
    .bind(Date.now(), uid)
    .run();

  if (!result.meta.changes) return c.json({ error: 'User not found' }, 404);

  const label = pref === 'uploads' ? 'new upload notifications' : 'comment notifications';
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Unsubscribed — Spooool</title></head><body style="font-family:sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.5rem">You've been unsubscribed</h1>` +
    `<p>You'll no longer receive ${label} from Spooool.</p>` +
    `<p><a href="/settings/account">Manage all notification preferences</a></p>` +
    `</body></html>`,
    200,
  );
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
