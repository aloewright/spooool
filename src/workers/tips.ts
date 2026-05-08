// ALO-162: per-video tipping.
//
// Flow:
//   1. Creator hits POST /api/tips/connect/onboard — we create a Stripe
//      Connect Express account (or reuse the existing one) and return an
//      AccountLink the creator can redirect to.
//   2. Stripe redirects them back; on next visit we call account.retrieve
//      via GET /api/tips/connect/status, mirror charges_enabled etc. into
//      creator_payouts, and surface "ready to receive tips" on the UI.
//   3. Anyone (auth optional) hits POST /api/videos/:id/tips/checkout with
//      an amount + optional message + anonymous flag. We create a Checkout
//      session with `payment_intent_data.application_fee_amount` and
//      `transfer_data.destination = creator_stripe_account_id`. A pending
//      `tips` row is inserted keyed by session id.
//   4. Stripe POSTs checkout.session.completed to /api/webhooks/stripe.
//      We verify the signature, look up the row by session id, flip it to
//      'paid', and persist the payment_intent for refund tracing.
//
// Pure helpers (validateTipInput, computePlatformFee, parseStripeMetadata)
// are exported separately so they can be unit-tested without a Stripe
// mock.

import { Hono } from 'hono';
import Stripe from 'stripe';

export interface TipsEnv {
  DB: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Public origin used when constructing Checkout success/cancel URLs and
  // Connect onboarding return URLs. Falls back to the request origin when
  // unset.
  PUBLIC_ORIGIN?: string;
}

type SessionUser = { id: string; email: string; name: string } | null;
type TipsVariables = { user: SessionUser };

// Platform fee: 10% of the tip, with a $0.30 floor on tips >= $1 to cover
// Stripe's fixed per-charge fee. Anything under $1 is just 10%. Returns
// the integer cent amount Stripe expects in `application_fee_amount`.
const PLATFORM_FEE_BPS = 1000; // 10.00%
const PLATFORM_FEE_FLOOR_CENTS = 30;
const PLATFORM_FEE_FLOOR_THRESHOLD_CENTS = 100;

export function computePlatformFee(amountCents: number): number {
  const pct = Math.round((amountCents * PLATFORM_FEE_BPS) / 10_000);
  if (amountCents >= PLATFORM_FEE_FLOOR_THRESHOLD_CENTS) {
    return Math.max(pct, PLATFORM_FEE_FLOOR_CENTS);
  }
  return pct;
}

// Tip amount bounds: $1 minimum (Stripe Checkout floor for most cards is
// $0.50, we lift it because micro-tips don't survive the platform fee
// floor cleanly), $500 maximum (anti-fraud sanity cap; legitimate big
// tippers can send multiple).
export const MIN_TIP_CENTS = 100;
export const MAX_TIP_CENTS = 500_00;
export const MAX_MESSAGE_LENGTH = 280;

export type TipInput = {
  amountCents: number;
  message?: string | null;
  anonymous?: boolean;
};

export type TipInputError =
  | 'amount_too_small'
  | 'amount_too_large'
  | 'amount_invalid'
  | 'message_too_long';

export function validateTipInput(raw: unknown): TipInput | TipInputError {
  if (typeof raw !== 'object' || raw === null) return 'amount_invalid';
  const r = raw as Record<string, unknown>;
  const amt = r.amount_cents;
  if (typeof amt !== 'number' || !Number.isInteger(amt) || amt <= 0) {
    return 'amount_invalid';
  }
  if (amt < MIN_TIP_CENTS) return 'amount_too_small';
  if (amt > MAX_TIP_CENTS) return 'amount_too_large';
  let message: string | null = null;
  if (typeof r.message === 'string') {
    const trimmed = r.message.trim();
    if (trimmed.length > MAX_MESSAGE_LENGTH) return 'message_too_long';
    message = trimmed.length > 0 ? trimmed : null;
  }
  const anonymous = r.anonymous === true;
  return { amountCents: amt, message, anonymous };
}

// Stripe stores arbitrary key/value strings on PaymentIntents and Sessions;
// we round-trip our internal ids through metadata so the webhook handler
// can correlate without trusting client input.
export type TipMetadata = {
  tip_id: string;
  video_id: string;
  creator_user_id: string;
};

export function parseStripeMetadata(raw: Stripe.Metadata | null | undefined): TipMetadata | null {
  if (!raw) return null;
  const tip_id = raw.tip_id;
  const video_id = raw.video_id;
  const creator_user_id = raw.creator_user_id;
  if (!tip_id || !video_id || !creator_user_id) return null;
  return { tip_id, video_id, creator_user_id };
}

function newId(): string {
  return crypto.randomUUID();
}

function publicOrigin(env: TipsEnv, req: Request): string {
  if (env.PUBLIC_ORIGIN && env.PUBLIC_ORIGIN.length > 0) return env.PUBLIC_ORIGIN;
  return new URL(req.url).origin;
}

function makeStripe(env: TipsEnv): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

async function getCreatorPayout(
  db: D1Database,
  userId: string,
): Promise<{
  stripe_account_id: string;
  charges_enabled: number;
  payouts_enabled: number;
  details_submitted: number;
} | null> {
  return db
    .prepare(
      `SELECT stripe_account_id, charges_enabled, payouts_enabled, details_submitted
       FROM creator_payouts WHERE user_id = ?`,
    )
    .bind(userId)
    .first();
}

async function upsertCreatorPayout(
  db: D1Database,
  userId: string,
  acct: Stripe.Account,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO creator_payouts (
         user_id, stripe_account_id, charges_enabled, payouts_enabled,
         details_submitted, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         charges_enabled = excluded.charges_enabled,
         payouts_enabled = excluded.payouts_enabled,
         details_submitted = excluded.details_submitted,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      acct.id,
      acct.charges_enabled ? 1 : 0,
      acct.payouts_enabled ? 1 : 0,
      acct.details_submitted ? 1 : 0,
      now,
      now,
    )
    .run();
}

export const tipRoutes = new Hono<{
  Bindings: TipsEnv;
  Variables: TipsVariables;
}>();

// --- Connect onboarding -----------------------------------------------------

tipRoutes.post('/api/tips/connect/onboard', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const stripe = makeStripe(c.env);
  if (!stripe) return c.json({ error: 'Tipping is not configured' }, 503);

  const existing = await getCreatorPayout(c.env.DB, user.id);
  let accountId = existing?.stripe_account_id;
  if (!accountId) {
    const acct = await stripe.accounts.create({
      type: 'express',
      email: user.email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      metadata: { user_id: user.id },
    });
    accountId = acct.id;
    await upsertCreatorPayout(c.env.DB, user.id, acct);
  }

  const origin = publicOrigin(c.env, c.req.raw);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/account/payouts?refresh=1`,
    return_url: `${origin}/account/payouts?ok=1`,
    type: 'account_onboarding',
  });
  return c.json({ url: link.url });
});

tipRoutes.get('/api/tips/connect/status', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const stripe = makeStripe(c.env);
  if (!stripe) return c.json({ connected: false, charges_enabled: false, payouts_enabled: false });

  const row = await getCreatorPayout(c.env.DB, user.id);
  if (!row) return c.json({ connected: false, charges_enabled: false, payouts_enabled: false });

  // Refresh from Stripe so charges_enabled flips on without waiting for a
  // webhook hookup. Cheap (one GET per visit to /account/payouts).
  try {
    const acct = await stripe.accounts.retrieve(row.stripe_account_id);
    await upsertCreatorPayout(c.env.DB, user.id, acct);
    return c.json({
      connected: true,
      charges_enabled: acct.charges_enabled ?? false,
      payouts_enabled: acct.payouts_enabled ?? false,
      details_submitted: acct.details_submitted ?? false,
    });
  } catch {
    return c.json({
      connected: true,
      charges_enabled: row.charges_enabled === 1,
      payouts_enabled: row.payouts_enabled === 1,
      details_submitted: row.details_submitted === 1,
    });
  }
});

// --- Per-video tip surface --------------------------------------------------

tipRoutes.get('/api/videos/:id/tips', async (c) => {
  const id = c.req.param('id');
  const summary = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents
     FROM tips WHERE video_id = ? AND status = 'paid'`,
  )
    .bind(id)
    .first<{ count: number; total_cents: number }>();
  const messages = await c.env.DB.prepare(
    `SELECT id, amount_cents, message, anonymous, created_at
     FROM tips
     WHERE video_id = ? AND status = 'paid' AND message IS NOT NULL AND message <> ''
     ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(id)
    .all<{
      id: string;
      amount_cents: number;
      message: string;
      anonymous: number;
      created_at: number;
    }>();
  return c.json({
    count: Number(summary?.count ?? 0),
    total_cents: Number(summary?.total_cents ?? 0),
    messages: (messages.results ?? []).map((m) => ({
      id: m.id,
      amount_cents: m.amount_cents,
      message: m.message,
      anonymous: m.anonymous === 1,
      created_at: m.created_at,
    })),
  });
});

tipRoutes.post('/api/videos/:id/tips/checkout', async (c) => {
  const stripe = makeStripe(c.env);
  if (!stripe) return c.json({ error: 'Tipping is not configured' }, 503);
  const videoId = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const validated = validateTipInput(body);
  if (typeof validated === 'string') {
    return c.json({ error: validated }, 400);
  }

  const video = await c.env.DB.prepare(
    `SELECT id, user_id, title FROM videos WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(videoId)
    .first<{ id: string; user_id: string; title: string }>();
  if (!video) return c.json({ error: 'Video not found' }, 404);

  const creatorPayout = await getCreatorPayout(c.env.DB, video.user_id);
  if (!creatorPayout || creatorPayout.charges_enabled !== 1) {
    return c.json({ error: 'Creator is not accepting tips yet' }, 409);
  }

  const tipId = newId();
  const platformFee = computePlatformFee(validated.amountCents);
  const supporter = c.get('user');
  const origin = publicOrigin(c.env, c.req.raw);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    success_url: `${origin}/watch/${videoId}?tip=success`,
    cancel_url: `${origin}/watch/${videoId}?tip=cancel`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: validated.amountCents,
          product_data: {
            name: `Tip for "${video.title.slice(0, 80)}"`,
          },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFee,
      transfer_data: { destination: creatorPayout.stripe_account_id },
      metadata: {
        tip_id: tipId,
        video_id: videoId,
        creator_user_id: video.user_id,
      },
    },
    metadata: {
      tip_id: tipId,
      video_id: videoId,
      creator_user_id: video.user_id,
    },
    customer_email: supporter?.email,
  });

  if (!session.url) {
    return c.json({ error: 'Stripe did not return a checkout URL' }, 502);
  }

  await c.env.DB.prepare(
    `INSERT INTO tips (
       id, video_id, creator_user_id, supporter_user_id, supporter_email,
       amount_cents, currency, platform_fee_cents, message, anonymous,
       status, stripe_session_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      tipId,
      videoId,
      video.user_id,
      supporter?.id ?? null,
      supporter?.email ?? null,
      validated.amountCents,
      platformFee,
      validated.message ?? null,
      validated.anonymous ? 1 : 0,
      session.id,
      Math.floor(Date.now() / 1000),
    )
    .run();

  return c.json({ url: session.url, tip_id: tipId });
});

// --- Stripe webhook ---------------------------------------------------------

export async function handleStripeWebhook(env: TipsEnv, req: Request): Promise<Response> {
  const stripe = makeStripe(env);
  if (!stripe) return new Response('Stripe not configured', { status: 503 });
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('Webhook secret not configured', { status: 503 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, sig, secret);
  } catch (err) {
    return new Response(
      `Invalid signature: ${err instanceof Error ? err.message : 'unknown'}`,
      { status: 400 },
    );
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const meta = parseStripeMetadata(session.metadata);
    if (!meta) return new Response('ok', { status: 200 });
    const paidAt = Math.floor(Date.now() / 1000);
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : null;
    await env.DB.prepare(
      `UPDATE tips SET status = 'paid', paid_at = ?, stripe_payment_intent = ?
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(paidAt, pi, meta.tip_id)
      .run();
  } else if (event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const meta = parseStripeMetadata(session.metadata);
    if (meta) {
      await env.DB.prepare(`UPDATE tips SET status = 'failed' WHERE id = ? AND status = 'pending'`)
        .bind(meta.tip_id)
        .run();
    }
  } else if (event.type === 'payment_intent.payment_failed') {
    // Sync card failures (3DS abort, network insufficient_funds) come through
    // here without a corresponding session.* event. Use payment_intent.metadata
    // (set by checkout.sessions.create above) to find the row.
    const intent = event.data.object as Stripe.PaymentIntent;
    const meta = parseStripeMetadata(intent.metadata);
    if (meta) {
      await env.DB.prepare(`UPDATE tips SET status = 'failed' WHERE id = ? AND status = 'pending'`)
        .bind(meta.tip_id)
        .run();
    }
  } else if (event.type === 'charge.refunded') {
    // Refunds are issued asynchronously by support / fraud reversal. We mark
    // the tip refunded so the public per-video tip list drops it; the row
    // stays for audit. Both full and partial refunds set this state — finer
    // distinctions can be reconstructed from Stripe.
    const charge = event.data.object as Stripe.Charge;
    const intentId =
      typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (intentId) {
      await env.DB.prepare(
        `UPDATE tips SET status = 'refunded'
         WHERE stripe_payment_intent = ? AND status = 'paid'`,
      )
        .bind(intentId)
        .run();
    }
  } else if (event.type === 'account.updated') {
    const acct = event.data.object as Stripe.Account;
    const userId = acct.metadata?.user_id;
    if (userId) {
      await upsertCreatorPayout(env.DB, userId, acct);
    }
  }

  return new Response('ok', { status: 200 });
}
