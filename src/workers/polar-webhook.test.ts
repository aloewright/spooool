import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  buildLedgerEntries,
  handlePolarWebhook,
  verifyPolarSignature,
} from './polar-webhook';

const SECRET = 'whsec_' + btoa('super-secret-shared-key');

async function signBody(body: string, id: string, ts: number, secret: string): Promise<string> {
  const trimmed = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  // Match decodeSecret(): try base64, fall back to UTF-8.
  let keyBytes: Uint8Array;
  try {
    const bin = atob(trimmed);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
    if (keyBytes.length === 0) throw new Error('empty');
  } catch {
    keyBytes = new TextEncoder().encode(trimmed);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${ts}.${body}`),
  );
  const bytes = new Uint8Array(sig);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

interface EventRow {
  webhook_id: string;
  event_type: string;
  received_at: number;
  payload_json: string;
}
interface LedgerRow {
  webhook_id: string;
  event_type: string;
  entry_kind: string;
  external_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  order_id: string | null;
  amount_cents: number;
  currency: string | null;
  occurred_at: number;
}

function makeFakeDB() {
  const events: EventRow[] = [];
  const ledger: LedgerRow[] = [];
  const ledgerKeys = new Set<string>();

  function makeStmt(query: string) {
    let bound: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async run() {
        if (query.includes('INTO polar_webhook_events')) {
          const [webhook_id, event_type, received_at, payload_json] = bound as [
            string,
            string,
            number,
            string,
          ];
          if (events.some((e) => e.webhook_id === webhook_id)) {
            return { meta: { changes: 0 } };
          }
          events.push({ webhook_id, event_type, received_at, payload_json });
          return { meta: { changes: 1 } };
        }
        if (query.includes('INTO polar_ledger')) {
          const [
            webhook_id,
            event_type,
            entry_kind,
            external_id,
            customer_id,
            subscription_id,
            order_id,
            amount_cents,
            currency,
            occurred_at,
          ] = bound as [
            string,
            string,
            string,
            string | null,
            string | null,
            string | null,
            string | null,
            number,
            string | null,
            number,
          ];
          const key = `${webhook_id}|${entry_kind}|${external_id}`;
          if (ledgerKeys.has(key)) return { meta: { changes: 0 } };
          ledgerKeys.add(key);
          ledger.push({
            webhook_id,
            event_type,
            entry_kind,
            external_id,
            customer_id,
            subscription_id,
            order_id,
            amount_cents,
            currency,
            occurred_at,
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  }

  const db = {
    prepare: (query: string) => makeStmt(query),
    async batch(stmts: ReturnType<typeof makeStmt>[]) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;

  return { events, ledger, db };
}

const env = (db: D1Database) => ({ DB: db, POLAR_WEBHOOK_SECRET: SECRET });

function buildApp(now: number) {
  const app = new Hono<{ Bindings: { DB: D1Database; POLAR_WEBHOOK_SECRET?: string } }>();
  app.post('/api/webhooks/polar', handlePolarWebhook({ now: () => now }));
  return app;
}

async function postWebhook(
  app: ReturnType<typeof buildApp>,
  e: { DB: D1Database; POLAR_WEBHOOK_SECRET?: string },
  body: string,
  id: string,
  ts: number,
  secret: string,
) {
  const sig = await signBody(body, id, ts, secret);
  return app.request(
    '/api/webhooks/polar',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': `v1,${sig}`,
      },
      body,
    },
    e,
  );
}

describe('verifyPolarSignature', () => {
  it('accepts a fresh signed payload', async () => {
    const body = '{"type":"order.paid"}';
    const id = 'evt_1';
    const ts = 1_700_000_000;
    const sig = await signBody(body, id, ts, SECRET);
    const r = await verifyPolarSignature(
      body,
      { id, timestamp: String(ts), signature: `v1,${sig}` },
      SECRET,
      ts,
    );
    expect(r).toEqual({ ok: true });
  });

  it('rejects missing headers', async () => {
    const r = await verifyPolarSignature(
      '{}',
      { id: null, timestamp: null, signature: null },
      SECRET,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects stale timestamps', async () => {
    const body = '{}';
    const id = 'evt_1';
    const ts = 1_700_000_000;
    const sig = await signBody(body, id, ts, SECRET);
    const r = await verifyPolarSignature(
      body,
      { id, timestamp: String(ts), signature: `v1,${sig}` },
      SECRET,
      ts + 60 * 60,
    );
    expect(r).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects bad signatures', async () => {
    const body = '{"x":1}';
    const id = 'evt_1';
    const ts = 1_700_000_000;
    const sig = await signBody(body, id, ts, 'whsec_' + btoa('different-key'));
    const r = await verifyPolarSignature(
      body,
      { id, timestamp: String(ts), signature: `v1,${sig}` },
      SECRET,
      ts,
    );
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts when any v1 signature in the list matches', async () => {
    const body = '{}';
    const id = 'evt_x';
    const ts = 1_700_000_000;
    const good = await signBody(body, id, ts, SECRET);
    const bogus = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const r = await verifyPolarSignature(
      body,
      { id, timestamp: String(ts), signature: `v1,${bogus} v1,${good}` },
      SECRET,
      ts,
    );
    expect(r).toEqual({ ok: true });
  });
});

describe('buildLedgerEntries', () => {
  it('records order.paid as a positive credit', () => {
    const entries = buildLedgerEntries(
      'order.paid',
      { id: 'ord_1', amount: 1500, currency: 'USD', customer_id: 'cust_1' },
      1_700_000_000,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entry_kind: 'order',
      amount_cents: 1500,
      external_id: 'ord_1',
      customer_id: 'cust_1',
      currency: 'USD',
    });
  });

  it('records refunds as negative', () => {
    const e = buildLedgerEntries(
      'refund.created',
      { id: 'ref_1', amount: 500, order_id: 'ord_1' },
      1,
    );
    expect(e[0].amount_cents).toBe(-500);
    expect(e[0].entry_kind).toBe('refund');
  });

  it('records partner payouts as negative', () => {
    const e = buildLedgerEntries(
      'partner.payout.created',
      { id: 'po_1', amount: 2000 },
      1,
    );
    expect(e[0].amount_cents).toBe(-2000);
    expect(e[0].entry_kind).toBe('payout');
  });

  it('records disputes/chargebacks as negative', () => {
    const e = buildLedgerEntries(
      'dispute.created',
      { id: 'dp_1', amount: 1500 },
      1,
    );
    expect(e[0].amount_cents).toBe(-1500);
    expect(e[0].entry_kind).toBe('dispute');
  });

  it('returns nothing for unknown event types', () => {
    expect(buildLedgerEntries('customer.created', { id: 'cust_1' }, 1)).toEqual([]);
  });
});

describe('handlePolarWebhook', () => {
  it('returns 503 without a secret', async () => {
    const app = buildApp(1);
    const { db } = makeFakeDB();
    const res = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', body: '{}' },
      { DB: db },
    );
    expect(res.status).toBe(503);
  });

  it('rejects invalid signatures with 401', async () => {
    const app = buildApp(1_700_000_000);
    const { db } = makeFakeDB();
    const res = await app.request(
      '/api/webhooks/polar',
      {
        method: 'POST',
        headers: {
          'webhook-id': 'evt_1',
          'webhook-timestamp': '1700000000',
          'webhook-signature': 'v1,bogus',
        },
        body: '{"type":"order.paid"}',
      },
      env(db),
    );
    expect(res.status).toBe(401);
  });

  it('records an order.paid event into the ledger', async () => {
    const ts = 1_700_000_000;
    const app = buildApp(ts);
    const { events, ledger, db } = makeFakeDB();
    const body = JSON.stringify({
      type: 'order.paid',
      data: { id: 'ord_1', amount: 1500, currency: 'USD', customer_id: 'cust_1' },
    });
    const res = await postWebhook(app, env(db), body, 'evt_1', ts, SECRET);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entry_kind: 'order',
      amount_cents: 1500,
      external_id: 'ord_1',
    });
  });

  it('is idempotent — re-delivering the same webhook id does not double-record', async () => {
    const ts = 1_700_000_000;
    const app = buildApp(ts);
    const { events, ledger, db } = makeFakeDB();
    const body = JSON.stringify({
      type: 'order.paid',
      data: { id: 'ord_1', amount: 1500, currency: 'USD' },
    });
    const first = await postWebhook(app, env(db), body, 'evt_1', ts, SECRET);
    const second = await postWebhook(app, env(db), body, 'evt_1', ts, SECRET);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { replay?: boolean };
    expect(secondJson.replay).toBe(true);
    expect(events).toHaveLength(1);
    expect(ledger).toHaveLength(1);
  });

  it('records a refund as a negative ledger entry', async () => {
    const ts = 1_700_000_000;
    const app = buildApp(ts);
    const { ledger, db } = makeFakeDB();
    const body = JSON.stringify({
      type: 'refund.created',
      data: { id: 'ref_1', amount: 500, order_id: 'ord_1', currency: 'USD' },
    });
    const res = await postWebhook(app, env(db), body, 'evt_ref', ts, SECRET);
    expect(res.status).toBe(200);
    expect(ledger[0]).toMatchObject({
      entry_kind: 'refund',
      amount_cents: -500,
      order_id: 'ord_1',
    });
  });

  it('records a payout as negative', async () => {
    const ts = 1_700_000_000;
    const app = buildApp(ts);
    const { ledger, db } = makeFakeDB();
    const body = JSON.stringify({
      type: 'partner.payout.created',
      data: { id: 'po_1', amount: 2500 },
    });
    const res = await postWebhook(app, env(db), body, 'evt_po', ts, SECRET);
    expect(res.status).toBe(200);
    expect(ledger[0]).toMatchObject({ entry_kind: 'payout', amount_cents: -2500 });
  });

  it('records a dispute as negative', async () => {
    const ts = 1_700_000_000;
    const app = buildApp(ts);
    const { ledger, db } = makeFakeDB();
    const body = JSON.stringify({
      type: 'dispute.created',
      data: { id: 'dp_1', amount: 1200 },
    });
    const res = await postWebhook(app, env(db), body, 'evt_dp', ts, SECRET);
    expect(res.status).toBe(200);
    expect(ledger[0]).toMatchObject({ entry_kind: 'dispute', amount_cents: -1200 });
  });

  it('still records the event for non-ledger event types', async () => {
    const ts = 1_700_000_000;
    const app = buildApp(ts);
    const { events, ledger, db } = makeFakeDB();
    const body = JSON.stringify({ type: 'customer.created', data: { id: 'cust_x' } });
    const res = await postWebhook(app, env(db), body, 'evt_c', ts, SECRET);
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(ledger).toHaveLength(0);
  });
});
