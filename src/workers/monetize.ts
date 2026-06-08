// Monetization routes: tip checkout, membership checkout, and creator product management.
//
// Creator flow:
//   1. Creator connects Polar (account.ts /api/account/polar/connect)
//   2. Creator creates products in Polar dashboard (tip / membership tiers)
//   3. Creator links products here via POST /api/account/products
//   4. Viewers tip or subscribe via POST /api/videos/:id/tip or /api/channels/:u/membership
//   5. Polar webhook (polar-webhook.ts) writes earnings to creator_earnings
//
// Polar checkout creation uses the platform POLAR_ACCESS_TOKEN; Polar routes
// payment to the creator's organization via the partner program.

import { Hono } from 'hono';
import { z } from 'zod';

const POLAR_BASE = 'https://api.polar.sh';

export interface MonetizeEnv {
  DB: D1Database;
  POLAR_ACCESS_TOKEN?: string;
}

type SessionUser = { id: string; email: string } | null;
type MonetizeVars = { user: SessionUser };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const linkProductSchema = z.object({
  polar_product_id: z.string().min(1).max(200),
  polar_price_id: z.string().min(1).max(200),
  kind: z.enum(['membership', 'tip']),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  // null = custom / pay-what-you-want; otherwise fixed in cents
  amount_cents: z.number().int().positive().optional().nullable(),
  currency: z.string().length(3).toLowerCase().default('usd'),
  // null for tip (one-time); 'month' or 'year' for memberships
  billing_interval: z.enum(['month', 'year']).optional().nullable(),
});

const tipSchema = z.object({
  amount_cents: z.number().int().min(100).max(100_000), // $1–$1000
  message: z.string().max(280).optional(),
});

const membershipSchema = z.object({
  product_id: z.string().min(1), // channel_products.id
});

// ---------------------------------------------------------------------------
// Polar checkout helper
// ---------------------------------------------------------------------------

interface PolarCheckoutBody {
  product_price_id: string;
  success_url: string;
  amount?: number;
  customer_email?: string;
  metadata?: Record<string, string>;
}

interface PolarCheckoutResponse {
  id: string;
  url: string;
}

async function createPolarCheckout(
  token: string,
  body: PolarCheckoutBody,
): Promise<string | null> {
  try {
    const res = await fetch(`${POLAR_BASE}/v1/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[monetize] polar checkout failed', { status: res.status, body: text });
      return null;
    }
    const data = (await res.json()) as PolarCheckoutResponse;
    return data.url ?? null;
  } catch (err) {
    console.error('[monetize] polar checkout error', { err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const monetizeRoutes = new Hono<{
  Bindings: MonetizeEnv;
  Variables: MonetizeVars;
}>();

// Public: list active products for a channel (used by Channel page)
monetizeRoutes.get('/api/channels/:username/products', async (c) => {
  const username = c.req.param('username');

  const creator = await c.env.DB.prepare(
    'SELECT id FROM user WHERE username = ?',
  )
    .bind(username)
    .first<{ id: string }>();
  if (!creator) return c.json({ error: 'Channel not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, name, description, amount_cents, currency, billing_interval
     FROM channel_products
     WHERE user_id = ? AND active = 1
     ORDER BY kind DESC, amount_cents ASC NULLS LAST`,
  )
    .bind(creator.id)
    .all();

  return c.json({ products: results });
});

// Tip checkout — creates a Polar checkout URL for a one-time tip on a video.
// The amount is caller-supplied (within limits); the tip product must use
// Polar's "pay what you want" / custom price type.
monetizeRoutes.post('/api/videos/:id/tip', async (c) => {
  const videoId = c.req.param('id');

  const json = await c.req.json().catch(() => null);
  const parsed = tipSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tip', details: parsed.error.flatten() }, 400);
  }
  const { amount_cents, message } = parsed.data;

  if (!c.env.POLAR_ACCESS_TOKEN) {
    return c.json({ error: 'Payments not configured' }, 503);
  }

  // Fetch the video + creator in one query.
  const video = await c.env.DB.prepare(
    `SELECT v.id, v.user_id, u.username, u.polar_account_status
     FROM videos v
     JOIN user u ON v.user_id = u.id
     WHERE v.id = ? AND v.deleted_at IS NULL`,
  )
    .bind(videoId)
    .first<{
      id: string;
      user_id: string;
      username: string | null;
      polar_account_status: string | null;
    }>();
  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.polar_account_status !== 'active') {
    return c.json({ error: 'Creator has not enabled tipping' }, 422);
  }

  // Find the creator's tip product (at most one active per creator).
  const tipProduct = await c.env.DB.prepare(
    `SELECT id, polar_price_id
     FROM channel_products
     WHERE user_id = ? AND kind = 'tip' AND active = 1
     LIMIT 1`,
  )
    .bind(video.user_id)
    .first<{ id: string; polar_price_id: string }>();
  if (!tipProduct) {
    return c.json({ error: 'Creator has not configured tipping' }, 422);
  }

  const origin = new URL(c.req.url).origin;
  const successUrl = `${origin}/watch/${videoId}?tip_success=1`;
  const user = c.get('user');

  const metadata: Record<string, string> = {
    kind: 'tip',
    creator_user_id: video.user_id,
    video_id: videoId,
    channel_product_id: tipProduct.id,
  };
  if (message) metadata.message = message;

  const checkoutUrl = await createPolarCheckout(c.env.POLAR_ACCESS_TOKEN, {
    product_price_id: tipProduct.polar_price_id,
    success_url: successUrl,
    amount: amount_cents,
    customer_email: user?.email ?? undefined,
    metadata,
  });
  if (!checkoutUrl) {
    return c.json({ error: 'Failed to create checkout. Please try again.' }, 502);
  }

  return c.json({ checkout_url: checkoutUrl });
});

// Membership checkout — creates a Polar checkout URL for a recurring subscription.
monetizeRoutes.post('/api/channels/:username/membership', async (c) => {
  const username = c.req.param('username');

  const json = await c.req.json().catch(() => null);
  const parsed = membershipSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { product_id } = parsed.data;

  if (!c.env.POLAR_ACCESS_TOKEN) {
    return c.json({ error: 'Payments not configured' }, 503);
  }

  const creator = await c.env.DB.prepare(
    'SELECT id, polar_account_status FROM user WHERE username = ?',
  )
    .bind(username)
    .first<{ id: string; polar_account_status: string | null }>();
  if (!creator) return c.json({ error: 'Channel not found' }, 404);

  // Verify the product belongs to this creator and is active.
  const product = await c.env.DB.prepare(
    `SELECT id, polar_price_id
     FROM channel_products
     WHERE id = ? AND user_id = ? AND kind = 'membership' AND active = 1`,
  )
    .bind(product_id, creator.id)
    .first<{ id: string; polar_price_id: string }>();
  if (!product) return c.json({ error: 'Membership tier not found' }, 404);

  const origin = new URL(c.req.url).origin;
  const successUrl = `${origin}/channels/${encodeURIComponent(username)}?membership_success=1`;
  const user = c.get('user');

  const metadata: Record<string, string> = {
    kind: 'membership',
    creator_user_id: creator.id,
    channel_product_id: product.id,
  };

  const checkoutUrl = await createPolarCheckout(c.env.POLAR_ACCESS_TOKEN, {
    product_price_id: product.polar_price_id,
    success_url: successUrl,
    customer_email: user?.email ?? undefined,
    metadata,
  });
  if (!checkoutUrl) {
    return c.json({ error: 'Failed to create checkout. Please try again.' }, 502);
  }

  return c.json({ checkout_url: checkoutUrl });
});

// Creator: list their linked products
monetizeRoutes.get('/api/account/products', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, name, description, amount_cents, currency, billing_interval, active, created_at
     FROM channel_products
     WHERE user_id = ?
     ORDER BY kind DESC, created_at ASC`,
  )
    .bind(user.id)
    .all();

  return c.json({ products: results });
});

// Creator: link a Polar product to their channel
monetizeRoutes.post('/api/account/products', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  // Creator must have an active Polar payout account before they can accept payments.
  const row = await c.env.DB.prepare(
    'SELECT polar_account_status FROM user WHERE id = ?',
  )
    .bind(user.id)
    .first<{ polar_account_status: string | null }>();
  if (row?.polar_account_status !== 'active') {
    return c.json({ error: 'Complete Polar payout account setup first' }, 422);
  }

  const json = await c.req.json().catch(() => null);
  const parsed = linkProductSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid product', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  // Only one active tip product per creator — it uses custom pricing anyway.
  if (data.kind === 'tip') {
    const existing = await c.env.DB.prepare(
      `SELECT id FROM channel_products WHERE user_id = ? AND kind = 'tip' AND active = 1`,
    )
      .bind(user.id)
      .first();
    if (existing) {
      return c.json(
        { error: 'A tip product is already active. Remove it before adding another.' },
        409,
      );
    }
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO channel_products
       (id, user_id, polar_product_id, polar_price_id, kind, name, description,
        amount_cents, currency, billing_interval, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      user.id,
      data.polar_product_id,
      data.polar_price_id,
      data.kind,
      data.name,
      data.description ?? null,
      data.amount_cents ?? null,
      data.currency,
      data.billing_interval ?? null,
      Date.now(),
    )
    .run();

  return c.json({ id, kind: data.kind, name: data.name }, 201);
});

// Creator: deactivate a product (soft-delete; existing subscribers unaffected)
monetizeRoutes.delete('/api/account/products/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const productId = c.req.param('id');
  const result = await c.env.DB.prepare(
    'UPDATE channel_products SET active = 0 WHERE id = ? AND user_id = ?',
  )
    .bind(productId, user.id)
    .run();

  if (((result.meta?.changes as number | undefined) ?? 0) === 0) {
    return c.json({ error: 'Product not found' }, 404);
  }
  return c.json({ ok: true });
});
