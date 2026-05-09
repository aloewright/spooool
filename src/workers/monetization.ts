// ALO-125: monetization routes (creator-facing + viewer-facing).
//
// Surface:
//   POST   /api/monetization/onboarding/start     creator → Polar partner link
//   GET    /api/monetization/onboarding/status    creator onboarding state
//   POST   /api/monetization/tiers                creator creates membership tier
//   GET    /api/monetization/channels/:username/tiers  public tier list
//   DELETE /api/monetization/tiers/:tierId        creator archives a tier
//   POST   /api/monetization/memberships/checkout viewer → Polar Checkout (recurring)
//   POST   /api/monetization/tips/checkout        viewer → Polar Checkout (one-time)
//   GET    /api/monetization/me/memberships       viewer's active memberships
//   GET    /api/monetization/me/payouts           creator payouts dashboard
//
// Spec source of truth: docs in ALO-125. Polar is the Merchant of Record;
// the Spooool fee rate (POLAR_PLATFORM_FEE_BPS) is recorded per ledger
// row at webhook-time, not enforced here.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  createCheckout,
  createOneTimeProduct,
  createPartnerAccount,
  createRecurringProduct,
  type PolarEnv,
} from './polar';

export interface MonetizationEnv extends PolarEnv {
  DB: D1Database;
}

interface SessionUser {
  id: string;
  email: string;
  name: string;
}

type MonetizationVariables = { user: SessionUser | null };

const tierCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  amountCents: z.number().int().positive().max(100_000),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .default('USD'),
  interval: z.enum(['month', 'year']).optional().default('month'),
});

const membershipCheckoutSchema = z.object({
  tierId: z.string().min(1).max(64),
});

const tipCheckoutSchema = z.object({
  videoId: z.string().min(1).max(64),
  amountCents: z.number().int().positive().max(100_000),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .default('USD'),
});

export const monetizationRoutes = new Hono<{
  Bindings: MonetizationEnv;
  Variables: MonetizationVariables;
}>();

function requirePublicOrigin(env: MonetizationEnv, fallback: string): string {
  return env.PUBLIC_ORIGIN ?? fallback;
}

function requireOrgId(env: MonetizationEnv): string {
  if (!env.POLAR_ORGANIZATION_ID) {
    throw new Error('POLAR_ORGANIZATION_ID not configured');
  }
  return env.POLAR_ORGANIZATION_ID;
}

monetizationRoutes.post('/api/monetization/onboarding/start', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // If a row already exists, return the existing onboarding URL — Polar's
  // hosted flow will resume the partner application without losing state.
  const existing = await c.env.DB.prepare(
    `SELECT polar_account_id, status, onboarding_url, payouts_enabled
     FROM creator_polar_accounts WHERE user_id = ?`,
  )
    .bind(user.id)
    .first<{
      polar_account_id: string;
      status: string;
      onboarding_url: string | null;
      payouts_enabled: number;
    }>();
  if (existing) {
    return c.json({
      accountId: existing.polar_account_id,
      status: existing.status,
      onboardingUrl: existing.onboarding_url,
      payoutsEnabled: existing.payouts_enabled === 1,
    });
  }

  let link;
  try {
    link = await createPartnerAccount(c.env, {
      email: user.email,
      name: user.name,
      metadata: { user_id: user.id },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Polar onboarding unavailable', detail: message }, 502);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO creator_polar_accounts
       (user_id, polar_account_id, status, onboarding_url, payouts_enabled, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, 0, ?, ?)`,
  )
    .bind(user.id, link.accountId, link.onboardingUrl, now, now)
    .run();

  return c.json({
    accountId: link.accountId,
    status: 'pending',
    onboardingUrl: link.onboardingUrl,
    payoutsEnabled: false,
  });
});

monetizationRoutes.get('/api/monetization/onboarding/status', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT polar_account_id, status, onboarding_url, payouts_enabled
     FROM creator_polar_accounts WHERE user_id = ?`,
  )
    .bind(user.id)
    .first<{
      polar_account_id: string;
      status: string;
      onboarding_url: string | null;
      payouts_enabled: number;
    }>();
  if (!row) return c.json({ status: 'not_started' });
  return c.json({
    accountId: row.polar_account_id,
    status: row.status,
    onboardingUrl: row.onboarding_url,
    payoutsEnabled: row.payouts_enabled === 1,
  });
});

monetizationRoutes.post('/api/monetization/tiers', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = tierCreateSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tier', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  const account = await c.env.DB.prepare(
    `SELECT status, payouts_enabled FROM creator_polar_accounts WHERE user_id = ?`,
  )
    .bind(user.id)
    .first<{ status: string; payouts_enabled: number }>();
  if (!account || account.status !== 'active' || account.payouts_enabled !== 1) {
    return c.json(
      { error: 'Complete Polar onboarding before creating a membership tier', code: 'onboarding_incomplete' },
      400,
    );
  }

  let product;
  try {
    product = await createRecurringProduct(c.env, {
      organizationId: requireOrgId(c.env),
      name: `${user.name} — ${data.name}`,
      description: data.description,
      priceAmountCents: data.amountCents,
      priceCurrency: data.currency,
      recurringInterval: data.interval,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Polar product creation failed', detail: message }, 502);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO membership_tiers
       (id, creator_user_id, polar_product_id, polar_price_id, name, description,
        amount_cents, currency, interval, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      product.id,
      product.priceId,
      data.name,
      data.description,
      data.amountCents,
      data.currency.toUpperCase(),
      data.interval,
      now,
      now,
    )
    .run();

  return c.json(
    {
      id,
      name: data.name,
      description: data.description,
      amountCents: data.amountCents,
      currency: data.currency.toUpperCase(),
      interval: data.interval,
    },
    201,
  );
});

monetizationRoutes.get('/api/monetization/channels/:username/tiers', async (c) => {
  const username = c.req.param('username');
  const channel = await c.env.DB.prepare(
    `SELECT id FROM user WHERE username = ?`,
  )
    .bind(username)
    .first<{ id: string }>();
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, description, amount_cents, currency, interval
     FROM membership_tiers
     WHERE creator_user_id = ? AND archived_at IS NULL
     ORDER BY amount_cents ASC`,
  )
    .bind(channel.id)
    .all<{
      id: string;
      name: string;
      description: string;
      amount_cents: number;
      currency: string;
      interval: string;
    }>();

  return c.json({
    tiers: (results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      amountCents: r.amount_cents,
      currency: r.currency,
      interval: r.interval,
    })),
  });
});

monetizationRoutes.delete('/api/monetization/tiers/:tierId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const tierId = c.req.param('tierId');
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE membership_tiers
     SET archived_at = ?, updated_at = ?
     WHERE id = ? AND creator_user_id = ? AND archived_at IS NULL`,
  )
    .bind(now, now, tierId, user.id)
    .run();
  const changes = (result.meta?.changes as number | undefined) ?? 0;
  if (changes === 0) return c.json({ error: 'Tier not found' }, 404);
  return c.json({ id: tierId, archived: true });
});

monetizationRoutes.post('/api/monetization/memberships/checkout', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = membershipCheckoutSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid checkout', details: parsed.error.flatten() }, 400);
  }

  const tier = await c.env.DB.prepare(
    `SELECT id, creator_user_id, polar_price_id, polar_product_id
     FROM membership_tiers WHERE id = ? AND archived_at IS NULL`,
  )
    .bind(parsed.data.tierId)
    .first<{
      id: string;
      creator_user_id: string;
      polar_price_id: string | null;
      polar_product_id: string | null;
    }>();
  if (!tier) return c.json({ error: 'Tier not found' }, 404);
  if (!tier.polar_price_id) {
    return c.json({ error: 'Tier missing Polar price', code: 'tier_unprovisioned' }, 409);
  }
  if (tier.creator_user_id === user.id) {
    return c.json({ error: 'Cannot subscribe to your own channel' }, 400);
  }

  const successUrl = `${requirePublicOrigin(c.env, new URL(c.req.url).origin)}/settings/memberships?status=success`;

  let session;
  try {
    session = await createCheckout(c.env, {
      productPriceId: tier.polar_price_id,
      customerEmail: user.email,
      successUrl,
      metadata: {
        creator_user_id: tier.creator_user_id,
        subscriber_user_id: user.id,
        tier_id: tier.id,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Polar checkout failed', detail: message }, 502);
  }
  return c.json({ checkoutId: session.id, url: session.url });
});

monetizationRoutes.post('/api/monetization/tips/checkout', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = tipCheckoutSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tip', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  const video = await c.env.DB.prepare(
    `SELECT v.id, v.user_id AS creator_user_id, u.username AS creator_username
     FROM videos v
     JOIN user u ON u.id = v.user_id
     WHERE v.id = ? AND v.deleted_at IS NULL`,
  )
    .bind(data.videoId)
    .first<{ id: string; creator_user_id: string; creator_username: string }>();
  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.creator_user_id === user.id) {
    return c.json({ error: 'Cannot tip your own video' }, 400);
  }

  const account = await c.env.DB.prepare(
    `SELECT status, payouts_enabled FROM creator_polar_accounts WHERE user_id = ?`,
  )
    .bind(video.creator_user_id)
    .first<{ status: string; payouts_enabled: number }>();
  if (!account || account.status !== 'active' || account.payouts_enabled !== 1) {
    return c.json(
      { error: 'Creator is not accepting tips yet', code: 'creator_not_onboarded' },
      409,
    );
  }

  let product;
  try {
    product = await createOneTimeProduct(c.env, {
      organizationId: requireOrgId(c.env),
      name: `Tip — ${video.creator_username}`,
      description: `Per-video tip on video ${video.id}`,
      priceAmountCents: data.amountCents,
      priceCurrency: data.currency,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Polar product creation failed', detail: message }, 502);
  }

  const successUrl = `${requirePublicOrigin(c.env, new URL(c.req.url).origin)}/watch/${video.id}?tip=success`;

  let session;
  try {
    session = await createCheckout(c.env, {
      productPriceId: product.priceId,
      customerEmail: user.email,
      successUrl,
      metadata: {
        creator_user_id: video.creator_user_id,
        payer_user_id: user.id,
        video_id: video.id,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Polar checkout failed', detail: message }, 502);
  }
  return c.json({ checkoutId: session.id, url: session.url });
});

monetizationRoutes.get('/api/monetization/me/memberships', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.tier_id, m.status, m.current_period_end, m.canceled_at,
            t.name AS tier_name, t.amount_cents, t.currency, t.interval,
            u.username AS creator_username, u.name AS creator_name
     FROM memberships m
     JOIN membership_tiers t ON t.id = m.tier_id
     JOIN user u ON u.id = m.creator_user_id
     WHERE m.subscriber_user_id = ?
     ORDER BY m.created_at DESC`,
  )
    .bind(user.id)
    .all();
  return c.json({ memberships: results ?? [] });
});

monetizationRoutes.get('/api/monetization/me/payouts', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [totalsRow, ledgerRows, payoutRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(gross_amount_cents), 0) AS gross,
         COALESCE(SUM(platform_fee_cents), 0) AS fee,
         COALESCE(SUM(net_amount_cents), 0) AS net,
         COUNT(*) AS entries
       FROM monetization_ledger
       WHERE creator_user_id = ?`,
    )
      .bind(user.id)
      .first<{ gross: number; fee: number; net: number; entries: number }>(),
    c.env.DB.prepare(
      `SELECT id, kind, gross_amount_cents, platform_fee_cents, net_amount_cents,
              currency, occurred_at, video_id, membership_id
       FROM monetization_ledger
       WHERE creator_user_id = ?
       ORDER BY occurred_at DESC
       LIMIT 100`,
    )
      .bind(user.id)
      .all(),
    c.env.DB.prepare(
      `SELECT polar_payout_id, amount_cents, currency, status, arrival_date, created_at
       FROM payouts
       WHERE creator_user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
      .bind(user.id)
      .all(),
  ]);

  return c.json({
    totals: {
      grossCents: Number(totalsRow?.gross ?? 0),
      platformFeeCents: Number(totalsRow?.fee ?? 0),
      netCents: Number(totalsRow?.net ?? 0),
      entryCount: Number(totalsRow?.entries ?? 0),
    },
    ledger: ledgerRows.results ?? [],
    payouts: payoutRows.results ?? [],
  });
});
