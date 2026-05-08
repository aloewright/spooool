import { Hono } from 'hono';
import Stripe from 'stripe';
import { z } from 'zod';

// ALO-161: channel memberships (recurring tiers).
//
// Creators define one or more `channel_membership_tiers`. Viewers buy a
// subscription to a tier through Stripe Checkout. Each Stripe webhook
// event upserts the corresponding row in `channel_memberships`. The
// playback gate (videos.ts) calls `isActiveMember` to honor the
// per-video `members_only` flag.
//
// Stripe is optional infra: when STRIPE_SECRET_KEY is unset, the tier
// catalog still works (creators can manage rows) but checkout returns a
// structured 503 with code `stripe_unconfigured`. The webhook is also a
// no-op until STRIPE_WEBHOOK_SECRET is set.

export interface MembershipsEnv {
  DB: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Public origin used to build Checkout return URLs. When unset we read
  // it from the request's Origin header — Stripe rejects relative URLs.
  PUBLIC_BASE_URL?: string;
}

type SessionUser = { id: string } | null;
type MembershipsVariables = { user: SessionUser };

type IntervalLiteral = 'month' | 'year';

const tierBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional().default(''),
  priceCents: z.coerce.number().int().min(50).max(1_000_000),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/)
    .default('usd'),
  interval: z.enum(['month', 'year']).default('month'),
});

const tierUpdateSchema = tierBodySchema.partial();

export type TierRow = {
  id: string;
  channel_user_id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  interval: IntervalLiteral;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MembershipRow = {
  id: string;
  member_user_id: string;
  channel_user_id: string;
  tier_id: string;
  status: string;
  current_period_end: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
};

export const ACTIVE_MEMBERSHIP_STATUSES = ['active', 'trialing'] as const;
export type ActiveMembershipStatus = (typeof ACTIVE_MEMBERSHIP_STATUSES)[number];

export function isActiveMembershipStatus(status: string): status is ActiveMembershipStatus {
  return (ACTIVE_MEMBERSHIP_STATUSES as readonly string[]).includes(status);
}

// ALO-161: pure helper so the gate is testable without spinning a D1.
// `nowSeconds` lets tests freeze time; `currentPeriodEnd` is the Stripe
// `current_period_end` we mirrored at webhook time.
export function membershipIsActive(
  row: { status: string; current_period_end: number | null } | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!row) return false;
  if (!isActiveMembershipStatus(row.status)) return false;
  // current_period_end is optional — when Stripe hasn't reported it yet
  // (e.g. a fresh `customer.subscription.created` with status='active'),
  // trust the status; if it's set we honor it strictly.
  if (row.current_period_end != null && row.current_period_end <= nowSeconds) {
    return false;
  }
  return true;
}

export async function isActiveMember(
  db: D1Database,
  memberUserId: string,
  channelUserId: string,
): Promise<boolean> {
  if (memberUserId === channelUserId) return true;
  const row = await db
    .prepare(
      `SELECT status, current_period_end
       FROM channel_memberships
       WHERE member_user_id = ? AND channel_user_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(memberUserId, channelUserId)
    .first<{ status: string; current_period_end: number | null }>();
  return membershipIsActive(row);
}

function publicTier(row: TierRow): {
  id: string;
  channelUserId: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: IntervalLiteral;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    channelUserId: row.channel_user_id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    interval: row.interval,
    archived: row.archived_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findChannelByUsername(
  db: D1Database,
  username: string,
): Promise<{ id: string } | null> {
  return db
    .prepare('SELECT id FROM user WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();
}

function makeStripeClient(env: MembershipsEnv): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  // Workers run in V8, not Node — Stripe's default Node http client doesn't
  // exist. createFetchHttpClient() routes the SDK through global fetch.
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function publicBaseUrl(env: MembershipsEnv, request: Request): string | null {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const origin = request.headers.get('origin');
  if (origin) return origin.replace(/\/+$/, '');
  // Best-effort: derive origin from the request URL.
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export const membershipRoutes = new Hono<{
  Bindings: MembershipsEnv;
  Variables: MembershipsVariables;
}>();

// Public: list non-archived tiers for a channel. Used by the channel page
// paywall card and by the watch-page member-gate sheet.
membershipRoutes.get('/api/channels/:username/membership/tiers', async (c) => {
  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, channel_user_id, name, description, price_cents, currency, interval,
            stripe_product_id, stripe_price_id, archived_at, created_at, updated_at
     FROM channel_membership_tiers
     WHERE channel_user_id = ? AND archived_at IS NULL
     ORDER BY price_cents ASC, created_at ASC`,
  )
    .bind(channel.id)
    .all<TierRow>();

  return c.json({ tiers: (results ?? []).map(publicTier) });
});

// Owner-only: includes archived rows. Mounted under the same channel path
// so the channel-owner UI can `?include_archived=1`.
membershipRoutes.get('/api/channels/:username/membership/tiers/manage', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (channel.id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const { results } = await c.env.DB.prepare(
    `SELECT id, channel_user_id, name, description, price_cents, currency, interval,
            stripe_product_id, stripe_price_id, archived_at, created_at, updated_at
     FROM channel_membership_tiers
     WHERE channel_user_id = ?
     ORDER BY archived_at IS NULL DESC, price_cents ASC, created_at ASC`,
  )
    .bind(channel.id)
    .all<TierRow>();

  return c.json({ tiers: (results ?? []).map(publicTier) });
});

membershipRoutes.post('/api/channels/:username/membership/tiers', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (channel.id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = tierBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tier body', details: parsed.error.flatten() }, 400);
  }

  const tierId = crypto.randomUUID();
  const stripe = makeStripeClient(c.env);
  let stripeProductId: string | null = null;
  let stripePriceId: string | null = null;

  if (stripe) {
    try {
      const product = await stripe.products.create({
        name: `${parsed.data.name} — @${username}`,
        description: parsed.data.description || undefined,
        metadata: { spooool_tier_id: tierId, spooool_channel_user_id: channel.id },
      });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: parsed.data.priceCents,
        currency: parsed.data.currency,
        recurring: { interval: parsed.data.interval },
        metadata: { spooool_tier_id: tierId, spooool_channel_user_id: channel.id },
      });
      stripeProductId = product.id;
      stripePriceId = price.id;
    } catch (err) {
      return c.json(
        {
          error: 'Stripe rejected tier creation',
          code: 'stripe_error',
          details: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO channel_membership_tiers
       (id, channel_user_id, name, description, price_cents, currency, interval,
        stripe_product_id, stripe_price_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      tierId,
      channel.id,
      parsed.data.name,
      parsed.data.description,
      parsed.data.priceCents,
      parsed.data.currency,
      parsed.data.interval,
      stripeProductId,
      stripePriceId,
    )
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, channel_user_id, name, description, price_cents, currency, interval,
            stripe_product_id, stripe_price_id, archived_at, created_at, updated_at
     FROM channel_membership_tiers WHERE id = ?`,
  )
    .bind(tierId)
    .first<TierRow>();

  if (!row) return c.json({ error: 'Tier write failed' }, 500);
  return c.json({ tier: publicTier(row) }, 201);
});

membershipRoutes.patch('/api/channels/:username/membership/tiers/:tierId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const tierId = c.req.param('tierId');

  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (channel.id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const tier = await c.env.DB.prepare(
    `SELECT id, channel_user_id, name, description, price_cents, currency, interval,
            stripe_product_id, stripe_price_id, archived_at, created_at, updated_at
     FROM channel_membership_tiers WHERE id = ?`,
  )
    .bind(tierId)
    .first<TierRow>();
  if (!tier) return c.json({ error: 'Tier not found' }, 404);
  if (tier.channel_user_id !== channel.id) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = tierUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tier body', details: parsed.error.flatten() }, 400);
  }

  // Stripe Prices are immutable once created; if price/currency/interval
  // changes we'd have to spin up a new Price. For now we only let creators
  // edit name + description and reject mutations of the billing shape.
  const wantsBillingChange =
    (parsed.data.priceCents !== undefined && parsed.data.priceCents !== tier.price_cents) ||
    (parsed.data.currency !== undefined && parsed.data.currency !== tier.currency) ||
    (parsed.data.interval !== undefined && parsed.data.interval !== tier.interval);
  if (wantsBillingChange) {
    return c.json(
      {
        error:
          'Price, currency, and interval are immutable once a tier is created. Archive this tier and create a new one.',
        code: 'tier_billing_immutable',
      },
      400,
    );
  }

  const newName = parsed.data.name ?? tier.name;
  const newDescription = parsed.data.description ?? tier.description;

  await c.env.DB.prepare(
    `UPDATE channel_membership_tiers
     SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(newName, newDescription, tierId)
    .run();

  const stripe = makeStripeClient(c.env);
  if (stripe && tier.stripe_product_id) {
    // Best-effort sync; failure shouldn't roll back the local edit.
    try {
      await stripe.products.update(tier.stripe_product_id, {
        name: `${newName} — @${username}`,
        description: newDescription || undefined,
      });
    } catch (err) {
      console.warn('stripe product update failed', {
        tierId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const row = await c.env.DB.prepare(
    `SELECT id, channel_user_id, name, description, price_cents, currency, interval,
            stripe_product_id, stripe_price_id, archived_at, created_at, updated_at
     FROM channel_membership_tiers WHERE id = ?`,
  )
    .bind(tierId)
    .first<TierRow>();
  if (!row) return c.json({ error: 'Tier read failed' }, 500);
  return c.json({ tier: publicTier(row) });
});

membershipRoutes.delete('/api/channels/:username/membership/tiers/:tierId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const tierId = c.req.param('tierId');

  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (channel.id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const tier = await c.env.DB.prepare(
    `SELECT id, channel_user_id, stripe_product_id, archived_at
     FROM channel_membership_tiers WHERE id = ?`,
  )
    .bind(tierId)
    .first<{ id: string; channel_user_id: string; stripe_product_id: string | null; archived_at: string | null }>();
  if (!tier) return c.json({ error: 'Tier not found' }, 404);
  if (tier.channel_user_id !== channel.id) return c.json({ error: 'Forbidden' }, 403);

  if (!tier.archived_at) {
    await c.env.DB.prepare(
      `UPDATE channel_membership_tiers
       SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(tierId)
      .run();
  }

  // Mark the Stripe product inactive so it stops appearing in dashboards.
  // Existing subscriptions to this price keep billing — we don't auto-cancel.
  const stripe = makeStripeClient(c.env);
  if (stripe && tier.stripe_product_id) {
    try {
      await stripe.products.update(tier.stripe_product_id, { active: false });
    } catch (err) {
      console.warn('stripe product archive failed', {
        tierId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({ archived: true });
});

// Viewer status: is the current user an active member of this channel?
membershipRoutes.get('/api/channels/:username/membership/me', async (c) => {
  const user = c.get('user');
  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  if (!user) return c.json({ active: false, isOwner: false });
  const isOwner = channel.id === user.id;
  if (isOwner) return c.json({ active: true, isOwner: true });

  const row = await c.env.DB.prepare(
    `SELECT tier_id, status, current_period_end
     FROM channel_memberships
     WHERE member_user_id = ? AND channel_user_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
    .bind(user.id, channel.id)
    .first<{ tier_id: string; status: string; current_period_end: number | null }>();

  return c.json({
    active: membershipIsActive(row),
    isOwner: false,
    status: row?.status ?? null,
    tierId: row?.tier_id ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
  });
});

// Start a Stripe Checkout session for a tier. Returns the hosted-checkout
// URL — the SPA does a top-level redirect.
membershipRoutes.post('/api/channels/:username/membership/checkout', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const username = c.req.param('username');
  const channel = await findChannelByUsername(c.env.DB, username);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (channel.id === user.id) {
    return c.json({ error: 'Cannot subscribe to your own channel' }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const tierIdRaw = body && typeof body === 'object' ? (body as { tierId?: unknown }).tierId : undefined;
  if (typeof tierIdRaw !== 'string' || tierIdRaw.length === 0) {
    return c.json({ error: 'tierId is required' }, 400);
  }

  const tier = await c.env.DB.prepare(
    `SELECT id, channel_user_id, stripe_price_id, archived_at
     FROM channel_membership_tiers WHERE id = ?`,
  )
    .bind(tierIdRaw)
    .first<{ id: string; channel_user_id: string; stripe_price_id: string | null; archived_at: string | null }>();

  if (!tier) return c.json({ error: 'Tier not found' }, 404);
  if (tier.channel_user_id !== channel.id) {
    return c.json({ error: 'Tier does not belong to this channel' }, 400);
  }
  if (tier.archived_at) {
    return c.json({ error: 'Tier is archived' }, 400);
  }

  const stripe = makeStripeClient(c.env);
  if (!stripe || !tier.stripe_price_id) {
    return c.json(
      {
        error: 'Membership checkout is not configured. Try again later.',
        code: 'stripe_unconfigured',
      },
      503,
    );
  }

  const baseUrl = publicBaseUrl(c.env, c.req.raw);
  if (!baseUrl) return c.json({ error: 'Cannot determine return URL' }, 500);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: tier.stripe_price_id, quantity: 1 }],
      success_url: `${baseUrl}/channel/${encodeURIComponent(username)}?membership=success`,
      cancel_url: `${baseUrl}/channel/${encodeURIComponent(username)}?membership=cancelled`,
      client_reference_id: user.id,
      // Webhook handlers key off these to attribute the purchase. client_reference_id
      // alone isn't reachable on `customer.subscription.*` events, so we duplicate
      // the linkage in subscription metadata.
      subscription_data: {
        metadata: {
          spooool_member_user_id: user.id,
          spooool_channel_user_id: channel.id,
          spooool_tier_id: tier.id,
        },
      },
      metadata: {
        spooool_member_user_id: user.id,
        spooool_channel_user_id: channel.id,
        spooool_tier_id: tier.id,
      },
    });
    return c.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    return c.json(
      {
        error: 'Stripe rejected the checkout session',
        code: 'stripe_error',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

// Stripe webhook handler. Mounted via index.ts so it lands inside the
// CSRF-exempt webhook namespace. Stripe verifies via HMAC over the raw
// body, so we must consume `c.req.raw.text()` (not parsed JSON) and
// pass the raw signature header through.
export async function handleMembershipWebhook(
  request: Request,
  env: MembershipsEnv,
): Promise<Response> {
  const stripe = makeStripeClient(env);
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    // 200 so Stripe stops retrying — but log so an operator notices.
    console.warn('stripe webhook ignored: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET unset');
    return new Response(JSON.stringify({ ignored: true, reason: 'unconfigured' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('Missing stripe-signature', { status: 400 });

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.warn('stripe webhook signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Bad signature', { status: 400 });
  }

  try {
    await applyStripeEvent(env.DB, event);
  } catch (err) {
    console.error('stripe webhook apply failed', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Pure-ish: takes a parsed Stripe event and applies it to D1. Exported
// for unit tests so we can build synthetic events without spinning up
// the SDK / signature machinery.
export async function applyStripeEvent(
  db: D1Database,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const sub = event.data.object as Stripe.Subscription;
      await upsertMembership(db, sub);
      return;
    }
    case 'checkout.session.completed': {
      // Best-effort attribution: we mostly rely on subscription.* events,
      // but if Checkout completed and the subscription event is delayed we
      // can still create the row from the session payload.
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription' || !session.subscription) return;
      const memberUserId = session.client_reference_id ?? session.metadata?.spooool_member_user_id;
      const channelUserId = session.metadata?.spooool_channel_user_id;
      const tierId = session.metadata?.spooool_tier_id;
      if (!memberUserId || !channelUserId || !tierId) return;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id ?? null;
      await db
        .prepare(
          `INSERT INTO channel_memberships
             (id, member_user_id, channel_user_id, tier_id, status,
              stripe_subscription_id, stripe_customer_id)
           VALUES (?, ?, ?, ?, 'incomplete', ?, ?)
           ON CONFLICT(stripe_subscription_id) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          memberUserId,
          channelUserId,
          tierId,
          subscriptionId,
          customerId,
        )
        .run();
      return;
    }
    default:
      return;
  }
}

async function upsertMembership(db: D1Database, sub: Stripe.Subscription): Promise<void> {
  const memberUserId = sub.metadata?.spooool_member_user_id;
  const channelUserId = sub.metadata?.spooool_channel_user_id;
  const tierId = sub.metadata?.spooool_tier_id;
  if (!memberUserId || !channelUserId || !tierId) {
    console.warn('stripe subscription event missing spooool metadata', {
      id: sub.id,
      hasMember: Boolean(memberUserId),
      hasChannel: Boolean(channelUserId),
      hasTier: Boolean(tierId),
    });
    return;
  }
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const status = sub.status;
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end ?? null;

  // Try INSERT, fall back to UPDATE keyed on the unique stripe_subscription_id.
  await db
    .prepare(
      `INSERT INTO channel_memberships
         (id, member_user_id, channel_user_id, tier_id, status,
          current_period_end, stripe_customer_id, stripe_subscription_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         stripe_customer_id = excluded.stripe_customer_id,
         tier_id = excluded.tier_id,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      crypto.randomUUID(),
      memberUserId,
      channelUserId,
      tierId,
      status,
      periodEnd,
      customerId,
      sub.id,
    )
    .run();
}
