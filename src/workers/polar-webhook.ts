import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';

// Polar uses the Standard Webhooks spec (https://www.standardwebhooks.com/).
// The secret is base64-encoded and prefixed with "whsec_". The signed message
// is "{webhook-id}.{webhook-timestamp}.{rawBody}" and the signature is
// base64(HMAC-SHA-256(key, message)). The header carries one or more
// space-separated "v1,<base64>" entries to support key rotation.
export const POLAR_WEBHOOK_TOLERANCE_SECONDS = 60 * 5;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  try {
    // Normalise base64url (-, _) to base64 and restore padding so atob accepts
    // unpadded secrets (Polar's polar_whs_ key is 32 bytes → 43 unpadded chars).
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '='.repeat(4 - pad);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'malformed_secret' | 'stale_timestamp' | 'bad_signature' };

export async function verifyPolarSignature(
  rawBody: string,
  webhookId: string | null | undefined,
  webhookTimestamp: string | null | undefined,
  webhookSignature: string | null | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SignatureVerification> {
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: 'missing_header' };
  }

  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > POLAR_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  // Strip the secret prefix and decode the raw key bytes. Polar issues secrets
  // as "polar_whs_<base64>"; the Standard Webhooks spec uses "whsec_<base64>".
  // Either way the bytes after the prefix are the base64-encoded HMAC key.
  const b64Secret = secret.startsWith('polar_whs_')
    ? secret.slice('polar_whs_'.length)
    : secret.startsWith('whsec_')
      ? secret.slice('whsec_'.length)
      : secret;
  const keyBytes = base64ToBytes(b64Secret);
  if (keyBytes.length === 0) return { ok: false, reason: 'malformed_secret' };

  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const message = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const expected = new Uint8Array(signed);

  // The header may carry multiple "v1,<base64>" entries (key rotation).
  // Accept if any one of them matches.
  const entries = webhookSignature.split(' ');
  for (const entry of entries) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    const version = entry.slice(0, comma);
    const sigB64 = entry.slice(comma + 1);
    if (version !== 'v1') continue;
    const provided = base64ToBytes(sigB64);
    if (timingSafeEqual(expected, provided)) return { ok: true };
  }

  return { ok: false, reason: 'bad_signature' };
}

// ---------------------------------------------------------------------------
// Payload schema — permissive: Polar's shape varies by event type. We extract
// the fields we need and pass the rest to meta_json for audit.
// ---------------------------------------------------------------------------

const polarDataSchema = z
  .object({
    id: z.string().optional(),
    // monetary fields (orders, subscriptions, refunds)
    amount: z.number().int().nonnegative().optional(),
    net_amount: z.number().int().optional(),
    currency: z.string().optional(),
    // subscription / order status
    status: z.string().optional(),
    // customer / user references
    customer_id: z.string().optional(),
    user_id: z.string().optional(),
    // for payout events: which payout account received the funds
    account_id: z.string().optional(),
    // product reference — present on order events; used to look up the creator
    // when metadata is absent (e.g. subscription renewal orders).
    product_id: z.string().optional(),
    // subscription reference — present on order events that originate from a
    // recurring subscription (first payment and renewals).
    subscription_id: z.string().optional(),
    // metadata we attach when creating checkouts. Polar echoes values back with
    // their original JSON type (strings, numbers, booleans), so the value schema
    // must accept all three or validation 400s and Polar retries forever.
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .passthrough();

const polarWebhookSchema = z.object({
  type: z.string().min(1),
  data: polarDataSchema,
});

export type PolarEventType = string;

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

type LedgerStatus =
  | 'pending'
  | 'active'
  | 'paid'
  | 'cancelled'
  | 'revoked'
  | 'refunded'
  | 'disputed'
  | 'failed'
  | 'unknown';

function deriveStatus(eventType: string, dataStatus?: string): LedgerStatus {
  const et = eventType.toLowerCase();

  if (et.startsWith('refund.')) return 'refunded';
  if (et.includes('dispute') || et.includes('chargeback')) return 'disputed';

  if (et === 'order.created') return 'pending';
  if (et === 'order.paid') return 'paid';
  if (et === 'order.refunded') return 'refunded';

  if (et === 'subscription.created') return 'active';
  if (et === 'subscription.active') return 'active';
  if (et === 'subscription.uncancelled') return 'active';
  if (et === 'subscription.cancelled') return 'cancelled';
  if (et === 'subscription.revoked') return 'revoked';

  if (et === 'benefit_grant.created') return 'active';
  if (et === 'benefit_grant.updated') return 'active';
  if (et === 'benefit_grant.cycled') return 'active';
  if (et === 'benefit_grant.revoked') return 'revoked';

  if (et === 'pledge.created') return 'pending';
  if (et === 'pledge.paid') return 'paid';

  // For order.updated / subscription.updated, fall back to data.status.
  if (dataStatus) {
    const ds = dataStatus.toLowerCase();
    if (ds === 'paid' || ds === 'complete' || ds === 'completed') return 'paid';
    if (ds === 'active') return 'active';
    if (ds === 'pending' || ds === 'incomplete') return 'pending';
    if (ds === 'cancelled' || ds === 'canceled') return 'cancelled';
    if (ds === 'revoked') return 'revoked';
    if (ds === 'refunded') return 'refunded';
    if (ds === 'disputed') return 'disputed';
    if (ds === 'failed' || ds === 'past_due' || ds === 'unpaid') return 'failed';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface PolarWebhookEnv {
  DB: D1Database;
  POLAR_WEBHOOK_SECRET?: string;
}

export interface PolarWebhookDeps {
  now?: () => number;
  newId?: () => string;
}

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Post-insert earnings processing
// ---------------------------------------------------------------------------

// After a new ledger row lands, attempt to credit creator_earnings or
// creator_payouts. Failures are logged but never bubble up — we must not
// return a non-2xx to Polar or it will re-deliver the webhook indefinitely.

const PLATFORM_FEE_RATE = 0.10; // 10% Spooool cut

async function processEarningsEvent(
  db: D1Database,
  eventType: string,
  amountCents: number | null,
  currency: string | null,
  polarObjectId: string | null,
  data: z.infer<typeof polarDataSchema>,
  nowMs: number,
): Promise<void> {
  const et = eventType.toLowerCase();
  const meta = data.metadata ?? {};

  // order.paid → tip or membership earning
  if (et === 'order.paid') {
    if (!amountCents || !currency) return;

    // Primary: creator_user_id from checkout metadata.
    // Fallback: look up via product_id → channel_products for renewal orders
    // where Polar may not echo our checkout metadata.
    let creatorUserId = typeof meta.creator_user_id === 'string' ? meta.creator_user_id : null;
    if (!creatorUserId && data.product_id) {
      const row = await db
        .prepare(
          `SELECT user_id FROM channel_products
           WHERE polar_product_id = ? AND active = 1
           LIMIT 1`,
        )
        .bind(data.product_id)
        .first<{ user_id: string }>()
        .catch(() => null);
      if (row) creatorUserId = row.user_id;
    }
    if (!creatorUserId) return;

    const kind = (meta.kind === 'tip' || meta.kind === 'membership' || meta.kind === 'gift')
      ? (meta.kind as 'tip' | 'membership' | 'gift')
      : data.subscription_id
        ? 'membership'
        : 'tip';
    const feeCents = Math.round(amountCents * PLATFORM_FEE_RATE);

    let description: string | null = null;
    if (kind === 'tip' && meta.video_id) {
      description = `Tip on video ${meta.video_id}`;
      if (meta.message) description += `: ${meta.message}`;
    } else if (kind === 'membership') {
      description = 'Membership payment';
    }

    await db
      .prepare(
        `INSERT OR IGNORE INTO creator_earnings
           (id, user_id, kind, amount_cents, platform_fee_cents, currency,
            polar_order_id, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        creatorUserId,
        kind,
        amountCents,
        feeCents,
        currency.toLowerCase(),
        polarObjectId,
        description,
        nowMs,
      )
      .run()
      .catch((err: unknown) => {
        console.error('[polar-webhook] creator_earnings insert failed', { err });
      });
    return;
  }

  // payout.created / payout.paid → creator_payouts
  if (et === 'payout.created' || et === 'payout.paid') {
    if (!amountCents || !currency || !polarObjectId) return;

    // Find the creator by their polar_account_id.
    const accountId = data.account_id;
    if (!accountId) return;

    const user = await db
      .prepare('SELECT id FROM user WHERE polar_account_id = ?')
      .bind(accountId)
      .first<{ id: string }>()
      .catch(() => null);
    if (!user) return;

    const status = et === 'payout.paid' ? 'paid' : 'pending';
    const paidAt = et === 'payout.paid' ? nowMs : null;

    // Upsert on polar_payout_id: a payout.created lands first as 'pending', then
    // a later payout.paid for the same payout must advance it to 'paid' (and set
    // paid_at). INSERT OR IGNORE would drop the second event and leave it stuck.
    await db
      .prepare(
        `INSERT INTO creator_payouts
           (id, user_id, amount_cents, currency, polar_payout_id, status, paid_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(polar_payout_id) WHERE polar_payout_id IS NOT NULL DO UPDATE SET
           status = excluded.status,
           paid_at = COALESCE(excluded.paid_at, paid_at)`,
      )
      .bind(
        crypto.randomUUID(),
        user.id,
        amountCents,
        currency.toLowerCase(),
        polarObjectId,
        status,
        paidAt,
        nowMs,
      )
      .run()
      .catch((err: unknown) => {
        console.error('[polar-webhook] creator_payouts insert failed', { err });
      });
    return;
  }
}

export const handlePolarWebhook =
  (deps: PolarWebhookDeps = {}): MiddlewareHandler<{ Bindings: PolarWebhookEnv }> =>
  async (c: Context<{ Bindings: PolarWebhookEnv }>) => {
    const secret = c.env.POLAR_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ error: 'Webhook not configured' }, 503);
    }

    const rawBody = await c.req.text();
    const webhookId = c.req.header('webhook-id');
    const webhookTimestamp = c.req.header('webhook-timestamp');
    const webhookSignature = c.req.header('webhook-signature');

    const nowSecs = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
    const verification = await verifyPolarSignature(
      rawBody,
      webhookId,
      webhookTimestamp,
      webhookSignature,
      secret,
      nowSecs,
    );
    if (!verification.ok) {
      return c.json({ error: 'Invalid signature', reason: verification.reason }, 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = polarWebhookSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400);
    }

    const { type: eventType, data } = parsed.data;
    const status = deriveStatus(eventType, data.status);

    // amount: prefer net_amount for refunds so we capture what the merchant
    // actually receives/loses; fall back to amount for all other events.
    const isRefund = eventType.toLowerCase().startsWith('refund.');
    const amountCents =
      (isRefund ? (data.net_amount ?? data.amount) : data.amount) ?? null;
    const currency = data.currency?.toLowerCase() ?? null;

    const polarObjectId = data.id ?? null;
    const polarCustomerId = data.customer_id ?? null;
    // data.user_id is Polar's user identifier — may not correspond to our
    // user.id. Store it as-is; callers can JOIN on email if needed.
    const polarUserId = data.user_id ?? null;

    const id = deps.newId ? deps.newId() : generateId();
    const createdAt = nowSecs * 1000; // store as ms epoch, matching other tables

    // Idempotent write: UNIQUE constraint on webhook_id means a re-delivery
    // of the same event simply returns inserted=false with no error.
    const result = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO polar_ledger
         (id, webhook_id, event_type, polar_object_id, polar_customer_id,
          polar_user_id, amount_cents, currency, status, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        webhookId,
        eventType,
        polarObjectId,
        polarCustomerId,
        polarUserId,
        amountCents,
        currency,
        status,
        JSON.stringify(data),
        createdAt,
      )
      .run();

    const inserted = ((result.meta?.changes as number | undefined) ?? 0) > 0;
    if (!inserted) {
      // Duplicate delivery — already processed.
      return c.json({ ok: true, inserted: false, event_type: eventType }, 200);
    }

    console.log('[polar-webhook]', {
      webhook_id: webhookId,
      event_type: eventType,
      status,
      amount_cents: amountCents,
      currency,
      polar_object_id: polarObjectId,
      ledger_id: id,
    });

    // Best-effort: credit earnings/payouts from actionable events.
    // Runs after the ledger write so the webhook is always acknowledged
    // even if the secondary write fails.
    await processEarningsEvent(
      c.env.DB,
      eventType,
      amountCents,
      currency,
      polarObjectId,
      data,
      createdAt,
    );

    return c.json({ ok: true, inserted: true, event_type: eventType, ledger_id: id });
  };
