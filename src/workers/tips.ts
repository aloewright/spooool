import { Hono } from 'hono';
import Stripe from 'stripe';
import { z } from 'zod';

export interface TipsEnv {
  DB: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

type SessionUser = { id: string } | null;
type TipsVariables = { user: SessionUser };

const PLATFORM_FEE_PERCENT = 0.1;

function createStripe(env: TipsEnv): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

const tipCheckoutSchema = z.object({
  amountCents: z.number().int().min(100).max(100_000),
  message: z.string().max(500).optional(),
});

export const tipsRoutes = new Hono<{ Bindings: TipsEnv; Variables: TipsVariables }>();

// Creator: initiate or refresh Stripe Connect onboarding
tipsRoutes.post('/api/users/me/stripe/connect', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const stripe = createStripe(c.env);

  const existing = await c.env.DB.prepare(
    'SELECT stripe_account_id FROM stripe_connect_accounts WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ stripe_account_id: string }>();

  let accountId: string;
  if (existing) {
    accountId = existing.stripe_account_id;
  } else {
    const account = await stripe.accounts.create({ type: 'express' });
    accountId = account.id;
    await c.env.DB.prepare(
      'INSERT INTO stripe_connect_accounts (user_id, stripe_account_id) VALUES (?, ?)',
    )
      .bind(user.id, accountId)
      .run();
  }

  const origin = new URL(c.req.url).origin;
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/profile?stripe=refresh`,
    return_url: `${origin}/profile?stripe=connected`,
    type: 'account_onboarding',
  });

  return c.json({ url: link.url });
});

// Creator: get Connect account status
tipsRoutes.get('/api/users/me/stripe/connect', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    'SELECT stripe_account_id, charges_enabled, payouts_enabled FROM stripe_connect_accounts WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ stripe_account_id: string; charges_enabled: number; payouts_enabled: number }>();

  if (!row) return c.json({ connected: false, chargesEnabled: false });

  // Onboarding status is stable once completed, so trust the DB and skip the
  // blocking Stripe call. Only sync from Stripe while charges are not yet enabled.
  if (row.charges_enabled) {
    return c.json({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: row.payouts_enabled === 1,
    });
  }

  // Sync latest state from Stripe so the UI reflects onboarding completion.
  const stripe = createStripe(c.env);
  const account = await stripe.accounts.retrieve(row.stripe_account_id);

  if (account.charges_enabled && !row.charges_enabled) {
    await c.env.DB.prepare(
      `UPDATE stripe_connect_accounts
       SET charges_enabled = 1, payouts_enabled = ?, onboarded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
    )
      .bind(account.payouts_enabled ? 1 : 0, user.id)
      .run();
  }

  return c.json({
    connected: true,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
  });
});

// Viewer: create a one-off tip Checkout Session (anonymous-capable)
tipsRoutes.post('/api/videos/:id/tip/checkout', async (c) => {
  const videoId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = tipCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { amountCents, message } = parsed.data;

  const video = await c.env.DB.prepare(
    'SELECT id, user_id, title FROM videos WHERE id = ? AND deleted_at IS NULL AND hidden_at IS NULL',
  )
    .bind(videoId)
    .first<{ id: string; user_id: string; title: string }>();

  if (!video) return c.json({ error: 'Video not found' }, 404);

  const connectRow = await c.env.DB.prepare(
    'SELECT stripe_account_id, charges_enabled FROM stripe_connect_accounts WHERE user_id = ?',
  )
    .bind(video.user_id)
    .first<{ stripe_account_id: string; charges_enabled: number }>();

  if (!connectRow?.charges_enabled) {
    return c.json({ error: 'This creator has not enabled tipping yet.' }, 402);
  }

  const stripe = createStripe(c.env);
  const origin = new URL(c.req.url).origin;
  const applicationFeeAmount = Math.round(amountCents * PLATFORM_FEE_PERCENT);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: `Tip for "${video.title}"`,
            ...(message ? { description: message } : {}),
          },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFeeAmount,
      transfer_data: { destination: connectRow.stripe_account_id },
    },
    metadata: {
      videoId,
      creatorUserId: video.user_id,
      message: message ?? '',
    },
    success_url: `${origin}/watch/${videoId}?tip=success`,
    cancel_url: `${origin}/watch/${videoId}`,
  });

  return c.json({ url: session.url });
});

// Webhook: record completed tip payments
export async function handleStripeWebhook(
  request: Request,
  env: TipsEnv,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Stripe not configured', { status: 503 });
  }

  const stripe = createStripe(env);
  const signature = request.headers.get('stripe-signature') ?? '';
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const { videoId, creatorUserId, message } = session.metadata ?? {};
    if (videoId && creatorUserId && session.payment_status === 'paid') {
      await env.DB.prepare(
        `INSERT INTO tips (id, video_id, creator_user_id, amount_cents, currency, message, stripe_checkout_session_id, tipper_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stripe_checkout_session_id) DO NOTHING`,
      )
        .bind(
          crypto.randomUUID(),
          videoId,
          creatorUserId,
          session.amount_total ?? 0,
          session.currency ?? 'usd',
          message || null,
          session.id,
          session.customer_details?.email ?? null,
        )
        .run();
    }
  }

  return new Response('ok');
}
