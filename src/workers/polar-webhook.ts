// ALO-125: Polar webhook receiver.
//
// Polar sends Standard-Webhooks-signed events for orders, subscriptions,
// payouts, and partner-account state changes. We:
//   1. Verify the signature (raw body, never re-serialize).
//   2. Persist the raw event to `polar_events` keyed on webhook-id for
//      audit / replay.
//   3. Dispatch to handlers that update the canonical
//      `monetization_ledger`, `memberships`, `payouts`, and
//      `creator_polar_accounts` tables. Each ledger insert is keyed on
//      `polar_event_id` (UNIQUE), so retried deliveries no-op safely.
//
// Failure handling: dispatch errors are written to
// `polar_events.process_error` so an admin can replay; the HTTP response
// is still 200 so Polar doesn't retry indefinitely against a poison pill.
// The signature check itself returns 401 without persisting anything.

import type { Context, MiddlewareHandler } from 'hono';
import {
  parsePlatformFeeBps,
  splitFee,
  verifyWebhookSignature,
  type PolarEnv,
} from './polar';

export interface PolarWebhookEnv extends PolarEnv {
  DB: D1Database;
}

export interface PolarWebhookDeps {
  now?: () => number;
}

interface PolarOrderEvent {
  id: string;
  amount?: number;
  net_amount?: number;
  currency?: string;
  customer_id?: string;
  metadata?: Record<string, string | number | boolean | null>;
  product_id?: string;
  subscription_id?: string;
  paid_at?: string;
  created_at?: string;
}

interface PolarSubscriptionEvent {
  id: string;
  status: string;
  customer_id?: string;
  product_id?: string;
  current_period_end?: string;
  canceled_at?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

interface PolarPayoutEvent {
  id: string;
  account_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  arrival_date?: string;
  paid_at?: string;
  created_at?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

interface PolarAccountEvent {
  id: string;
  status?: string;
  payouts_enabled?: boolean;
  metadata?: Record<string, string | number | boolean | null>;
}

interface PolarEventEnvelope {
  type: string;
  data: unknown;
}

function toIso(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.floor(t) : null;
}

function metaString(
  meta: Record<string, string | number | boolean | null> | undefined,
  key: string,
): string | null {
  const v = meta?.[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

async function recordRawEvent(
  env: PolarWebhookEnv,
  webhookId: string,
  type: string,
  rawBody: string,
  receivedAt: number,
): Promise<{ inserted: boolean }> {
  // ON CONFLICT DO NOTHING means a redelivery (same webhook-id) is a
  // no-op, which is exactly what we want for the audit log too.
  const result = await env.DB.prepare(
    `INSERT INTO polar_events (id, event_type, payload, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(webhookId, type, rawBody, receivedAt)
    .run();
  const changes = (result.meta?.changes as number | undefined) ?? 0;
  return { inserted: changes > 0 };
}

async function markProcessed(
  env: PolarWebhookEnv,
  webhookId: string,
  now: number,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE polar_events SET processed_at = ?, process_error = ? WHERE id = ?`,
  )
    .bind(now, error ?? null, webhookId)
    .run();
}

async function findCreatorByCustomerOrAccount(
  env: PolarWebhookEnv,
  meta: { creatorUserId?: string | null; accountId?: string | null },
): Promise<string | null> {
  if (meta.creatorUserId) return meta.creatorUserId;
  if (meta.accountId) {
    const row = await env.DB.prepare(
      `SELECT user_id FROM creator_polar_accounts WHERE polar_account_id = ?`,
    )
      .bind(meta.accountId)
      .first<{ user_id: string }>();
    if (row?.user_id) return row.user_id;
  }
  return null;
}

async function handleOrder(
  env: PolarWebhookEnv,
  webhookId: string,
  data: PolarOrderEvent,
): Promise<void> {
  const grossRaw = data.amount ?? data.net_amount ?? 0;
  const feeBps = parsePlatformFeeBps(env);
  const split = splitFee(Number(grossRaw), feeBps);
  const occurredAt = toIso(data.paid_at) ?? toIso(data.created_at) ?? Date.now();

  const meta = data.metadata ?? {};
  const creatorMeta = metaString(meta, 'creator_user_id');
  const payerMeta = metaString(meta, 'subscriber_user_id') ?? metaString(meta, 'payer_user_id');
  const videoId = metaString(meta, 'video_id');
  const tierId = metaString(meta, 'tier_id');
  const polarAccountId = metaString(meta, 'polar_account_id');

  const creatorUserId = await findCreatorByCustomerOrAccount(env, {
    creatorUserId: creatorMeta,
    accountId: polarAccountId,
  });
  if (!creatorUserId) {
    throw new Error(
      `order ${data.id} missing creator_user_id metadata and no account match`,
    );
  }

  // Resolve membership row if this order was a recurring payment.
  let membershipId: string | null = null;
  if (data.subscription_id) {
    const m = await env.DB.prepare(
      `SELECT id FROM memberships WHERE polar_subscription_id = ?`,
    )
      .bind(data.subscription_id)
      .first<{ id: string }>();
    membershipId = m?.id ?? null;
  }

  const kind: 'tip' | 'membership_payment' = data.subscription_id || tierId
    ? 'membership_payment'
    : 'tip';

  await env.DB.prepare(
    `INSERT INTO monetization_ledger
       (id, polar_event_id, kind, creator_user_id, payer_user_id, video_id,
        membership_id, gross_amount_cents, platform_fee_cents,
        net_amount_cents, currency, occurred_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(polar_event_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      webhookId,
      kind,
      creatorUserId,
      payerMeta,
      videoId,
      membershipId,
      split.gross,
      split.fee,
      split.net,
      (data.currency ?? 'USD').toUpperCase(),
      occurredAt,
      JSON.stringify({ orderId: data.id, subscriptionId: data.subscription_id ?? null }),
    )
    .run();
}

async function handleSubscription(
  env: PolarWebhookEnv,
  data: PolarSubscriptionEvent,
): Promise<void> {
  const meta = data.metadata ?? {};
  const creatorMeta = metaString(meta, 'creator_user_id');
  const subscriberMeta = metaString(meta, 'subscriber_user_id');
  const tierId = metaString(meta, 'tier_id');

  if (!creatorMeta || !subscriberMeta || !tierId) {
    throw new Error(
      `subscription ${data.id} missing creator_user_id / subscriber_user_id / tier_id metadata`,
    );
  }

  const status = normalizeSubscriptionStatus(data.status);
  const now = Date.now();
  const periodEnd = toIso(data.current_period_end);
  const canceledAt = toIso(data.canceled_at);

  // Insert-or-update keyed on polar_subscription_id.
  await env.DB.prepare(
    `INSERT INTO memberships
       (id, polar_subscription_id, tier_id, creator_user_id, subscriber_user_id,
        status, current_period_end, canceled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(polar_subscription_id) DO UPDATE SET
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       canceled_at = excluded.canceled_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      data.id,
      tierId,
      creatorMeta,
      subscriberMeta,
      status,
      periodEnd,
      canceledAt,
      now,
      now,
    )
    .run();
}

async function handlePayout(
  env: PolarWebhookEnv,
  data: PolarPayoutEvent,
): Promise<void> {
  const accountId = data.account_id ?? metaString(data.metadata, 'polar_account_id');
  if (!accountId) {
    throw new Error(`payout ${data.id} missing account_id`);
  }
  const creator = await env.DB.prepare(
    `SELECT user_id FROM creator_polar_accounts WHERE polar_account_id = ?`,
  )
    .bind(accountId)
    .first<{ user_id: string }>();
  if (!creator) {
    throw new Error(`payout ${data.id} references unknown account ${accountId}`);
  }

  const status = normalizePayoutStatus(data.status);
  const now = Date.now();
  const arrival = toIso(data.arrival_date) ?? toIso(data.paid_at);

  await env.DB.prepare(
    `INSERT INTO payouts
       (id, polar_payout_id, creator_user_id, amount_cents, currency,
        status, arrival_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(polar_payout_id) DO UPDATE SET
       status = excluded.status,
       arrival_date = excluded.arrival_date,
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      data.id,
      creator.user_id,
      Number(data.amount ?? 0),
      (data.currency ?? 'USD').toUpperCase(),
      status,
      arrival,
      now,
      now,
    )
    .run();
}

async function handleAccount(
  env: PolarWebhookEnv,
  data: PolarAccountEvent,
): Promise<void> {
  const status = normalizeAccountStatus(data.status);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE creator_polar_accounts
     SET status = ?,
         payouts_enabled = ?,
         updated_at = ?
     WHERE polar_account_id = ?`,
  )
    .bind(status, data.payouts_enabled ? 1 : 0, now, data.id)
    .run();
}

function normalizeSubscriptionStatus(s: string): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'active' || v === 'trialing') return 'active';
  if (v === 'past_due' || v === 'unpaid') return 'past_due';
  if (v === 'canceled' || v === 'cancelled') return 'canceled';
  return 'incomplete';
}

function normalizePayoutStatus(s: string | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'paid' || v === 'succeeded' || v === 'completed') return 'paid';
  if (v === 'failed') return 'failed';
  if (v === 'canceled' || v === 'cancelled') return 'canceled';
  return 'pending';
}

function normalizeAccountStatus(s: string | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'active' || v === 'verified') return 'active';
  if (v === 'rejected') return 'rejected';
  if (v === 'disabled' || v === 'suspended') return 'disabled';
  return 'pending';
}

export async function dispatchPolarEvent(
  env: PolarWebhookEnv,
  webhookId: string,
  envelope: PolarEventEnvelope,
): Promise<void> {
  const type = envelope.type;
  const data = envelope.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return;

  if (type === 'order.created' || type === 'order.paid') {
    await handleOrder(env, webhookId, data as unknown as PolarOrderEvent);
    return;
  }
  if (
    type === 'subscription.created' ||
    type === 'subscription.updated' ||
    type === 'subscription.canceled'
  ) {
    await handleSubscription(env, data as unknown as PolarSubscriptionEvent);
    return;
  }
  if (
    type === 'payout.created' ||
    type === 'payout.updated' ||
    type === 'payout.paid'
  ) {
    await handlePayout(env, data as unknown as PolarPayoutEvent);
    return;
  }
  if (type === 'account.updated' || type === 'partner_account.updated') {
    await handleAccount(env, data as unknown as PolarAccountEvent);
    return;
  }
  // Unknown event types are recorded in polar_events but otherwise ignored.
}

export const handlePolarWebhook =
  (deps: PolarWebhookDeps = {}): MiddlewareHandler<{ Bindings: PolarWebhookEnv }> =>
  async (c: Context<{ Bindings: PolarWebhookEnv }>) => {
    const secret = c.env.POLAR_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ error: 'Webhook not configured' }, 503);
    }

    const rawBody = await c.req.text();
    const headers = {
      webhookId: c.req.header('webhook-id'),
      webhookTimestamp: c.req.header('webhook-timestamp'),
      webhookSignature: c.req.header('webhook-signature'),
    };

    const verification = await verifyWebhookSignature(
      rawBody,
      headers,
      secret,
      deps.now ? deps.now() : Math.floor(Date.now() / 1000),
    );
    if (!verification.ok) {
      return c.json({ error: 'Invalid signature', reason: verification.reason }, 401);
    }

    let envelope: PolarEventEnvelope;
    try {
      envelope = JSON.parse(rawBody) as PolarEventEnvelope;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!envelope || typeof envelope.type !== 'string') {
      return c.json({ error: 'Invalid event envelope' }, 400);
    }

    const webhookId = headers.webhookId as string;
    const nowMs = (deps.now ? deps.now() : Math.floor(Date.now() / 1000)) * 1000;

    const audit = await recordRawEvent(c.env, webhookId, envelope.type, rawBody, nowMs);

    if (!audit.inserted) {
      // Replay of an event we've already audited; whatever derived state
      // had to land has landed (or been recorded as an error). Acknowledge
      // without re-dispatching so partial-side-effect retries don't
      // double-write the ledger.
      return c.json({ ok: true, replay: true });
    }

    try {
      await dispatchPolarEvent(c.env, webhookId, envelope);
      await markProcessed(c.env, webhookId, nowMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[polar-webhook] dispatch failed', { webhookId, type: envelope.type, message });
      await markProcessed(c.env, webhookId, nowMs, message);
      // Acknowledge anyway — the raw event is in polar_events for replay.
      return c.json({ ok: true, deferred: true });
    }

    return c.json({ ok: true });
  };
