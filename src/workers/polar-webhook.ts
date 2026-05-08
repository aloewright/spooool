import type { Context, MiddlewareHandler } from 'hono';

// ALO-164: Polar webhook receiver.
//
// Polar uses the Standard Webhooks spec (https://www.standardwebhooks.com)
// — same scheme as Svix. Three headers travel with every delivery:
//
//   webhook-id         stable id, primary key for idempotency
//   webhook-timestamp  Unix seconds, replay-protected by tolerance window
//   webhook-signature  one or more `v1,<base64-sig>` entries, space-sep
//
// The signed payload is `${id}.${timestamp}.${body}` and the HMAC key is
// the raw bytes after stripping the `whsec_` prefix and base64-decoding
// the rest. We accept the delivery if any of the listed signatures match.
//
// On accept we (a) record the event id in `polar_webhook_events` so
// retries become no-ops and (b) write one or more rows into the
// `polar_ledger` describing the money movement. Both writes are issued
// as a D1 batch so a partial failure cannot half-record a delivery.

export const POLAR_WEBHOOK_TOLERANCE_SECONDS = 60 * 5;

export type SignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing_headers'
        | 'malformed_signature'
        | 'stale_timestamp'
        | 'bad_signature'
        | 'bad_secret';
    };

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function timingSafeEqualB64(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decodeSecret(secret: string): Uint8Array | null {
  const trimmed = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  // Standard Webhooks specifies the post-`whsec_` portion is base64. If a
  // caller passes a raw shared secret instead, fall back to its UTF-8
  // bytes so local dev isn't gated on base64 encoding the secret.
  const bytes = base64ToBytes(trimmed);
  if (bytes && bytes.length > 0) return bytes;
  return new TextEncoder().encode(trimmed);
}

export async function verifyPolarSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SignatureVerification> {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: 'missing_headers' };
  }
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed_signature' };
  if (Math.abs(now - ts) > POLAR_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const secretBytes = decodeSecret(secret);
  if (!secretBytes || secretBytes.length === 0) return { ok: false, reason: 'bad_secret' };

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${headers.id}.${ts}.${rawBody}`),
  );
  const expected = bytesToBase64(new Uint8Array(signed));

  // The header is a space-separated list of `version,sig` pairs.
  const parts = headers.signature.split(' ').filter(Boolean);
  for (const part of parts) {
    const comma = part.indexOf(',');
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    if (version !== 'v1') continue;
    if (timingSafeEqualB64(expected, sig)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

interface PolarEventEnvelope {
  type?: string;
  data?: unknown;
}

interface PolarObject {
  id?: string;
  customer_id?: string;
  customerId?: string;
  customer?: { id?: string };
  subscription_id?: string;
  subscriptionId?: string;
  subscription?: { id?: string };
  order_id?: string;
  orderId?: string;
  order?: { id?: string };
  amount?: number;
  net_amount?: number;
  total_amount?: number;
  amount_total?: number;
  amount_refunded?: number;
  currency?: string;
  created_at?: string;
  createdAt?: string;
  occurred_at?: string;
}

function pickAmountCents(obj: PolarObject): number {
  if (typeof obj.amount === 'number') return obj.amount;
  if (typeof obj.total_amount === 'number') return obj.total_amount;
  if (typeof obj.amount_total === 'number') return obj.amount_total;
  if (typeof obj.net_amount === 'number') return obj.net_amount;
  return 0;
}

function parseTimestamp(...candidates: Array<string | undefined>): number | null {
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

export interface LedgerEntry {
  entry_kind: string;
  external_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  order_id: string | null;
  amount_cents: number;
  currency: string | null;
  occurred_at: number;
}

// Translate a Polar event into one or more ledger entries. Returns an
// empty array for events we don't ledger (e.g. customer.created) — those
// still get recorded in `polar_webhook_events` for audit but don't move
// money.
export function buildLedgerEntries(
  eventType: string,
  data: unknown,
  receivedAt: number,
): LedgerEntry[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as PolarObject;
  const id = obj.id ?? null;
  const customer = obj.customer_id ?? obj.customerId ?? obj.customer?.id ?? null;
  const subscription =
    obj.subscription_id ?? obj.subscriptionId ?? obj.subscription?.id ?? null;
  const order = obj.order_id ?? obj.orderId ?? obj.order?.id ?? id;
  const currency = obj.currency ?? null;
  const occurred =
    parseTimestamp(obj.occurred_at, obj.created_at, obj.createdAt) ?? receivedAt;
  const amount = pickAmountCents(obj);

  const base = {
    external_id: id,
    customer_id: customer,
    subscription_id: subscription,
    order_id: order ?? null,
    currency,
    occurred_at: occurred,
  };

  switch (eventType) {
    case 'order.created':
    case 'order.paid':
    case 'order.updated':
      return [{ ...base, entry_kind: 'order', amount_cents: amount }];

    case 'subscription.created':
    case 'subscription.active':
    case 'subscription.updated':
    case 'subscription.canceled':
    case 'subscription.revoked':
      return [{ ...base, entry_kind: 'subscription', amount_cents: amount }];

    case 'refund.created':
    case 'refund.updated':
    case 'order.refunded': {
      // Refunds are debits — store as negative.
      const refund = obj.amount_refunded ?? amount;
      return [{ ...base, entry_kind: 'refund', amount_cents: -Math.abs(refund) }];
    }

    case 'partner.payout.created':
    case 'payout.created':
    case 'payout.paid':
      // Payouts move money out — negative amount.
      return [{ ...base, entry_kind: 'payout', amount_cents: -Math.abs(amount) }];

    case 'dispute.created':
    case 'dispute.updated':
    case 'chargeback.created':
      return [{ ...base, entry_kind: 'dispute', amount_cents: -Math.abs(amount) }];

    default:
      return [];
  }
}

export interface PolarWebhookEnv {
  DB: D1Database;
  POLAR_WEBHOOK_SECRET?: string;
}

export interface PolarWebhookDeps {
  now?: () => number;
}

export const handlePolarWebhook =
  (deps: PolarWebhookDeps = {}): MiddlewareHandler<{ Bindings: PolarWebhookEnv }> =>
  async (c: Context<{ Bindings: PolarWebhookEnv }>) => {
    const secret = c.env.POLAR_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'Webhook not configured' }, 503);

    const rawBody = await c.req.text();
    const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
    const id = c.req.header('webhook-id') ?? null;
    const timestamp = c.req.header('webhook-timestamp') ?? null;
    const signature = c.req.header('webhook-signature') ?? null;

    const verification = await verifyPolarSignature(
      rawBody,
      { id, timestamp, signature },
      secret,
      now,
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

    const eventType = typeof envelope.type === 'string' ? envelope.type : '';
    if (!eventType) return c.json({ error: 'Missing event type' }, 400);

    // INSERT OR IGNORE keys idempotency on `webhook_id`. If the row
    // already existed, `meta.changes` will be 0 and we treat the call
    // as a no-op replay rather than re-writing ledger rows.
    const insertEvent = c.env.DB.prepare(
      `INSERT OR IGNORE INTO polar_webhook_events (webhook_id, event_type, received_at, payload_json)
       VALUES (?, ?, ?, ?)`,
    ).bind(id, eventType, now, rawBody);

    const eventRes = await insertEvent.run();
    const inserted = (eventRes.meta?.changes as number | undefined) ?? 0;
    if (inserted === 0) {
      return c.json({ ok: true, replay: true }, 200);
    }

    const entries = buildLedgerEntries(eventType, envelope.data, now);
    if (entries.length > 0) {
      const stmts = entries.map((e) =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO polar_ledger
             (webhook_id, event_type, entry_kind, external_id, customer_id,
              subscription_id, order_id, amount_cents, currency, occurred_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          eventType,
          e.entry_kind,
          e.external_id,
          e.customer_id,
          e.subscription_id,
          e.order_id,
          e.amount_cents,
          e.currency,
          e.occurred_at,
          null,
        ),
      );
      await c.env.DB.batch(stmts);
    }

    return c.json({ ok: true, recorded: entries.length, event_type: eventType }, 200);
  };
