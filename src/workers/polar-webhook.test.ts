import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { handlePolarWebhook, verifyPolarSignature } from './polar-webhook';

// Raw secret bytes encoded as base64 (the part after the optional "whsec_" prefix).
const SECRET_BYTES = new TextEncoder().encode('test-polar-secret-32bytes-padding!');
const SECRET_B64 = btoa(String.fromCharCode(...SECRET_BYTES));
const SECRET = `whsec_${SECRET_B64}`;

async function signBody(id: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    SECRET_BYTES,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = `${id}.${timestamp}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

interface FakeLedgerRow {
  id: string;
  webhook_id: string;
  event_type: string;
  polar_object_id: string | null;
  polar_customer_id: string | null;
  polar_user_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string;
  meta_json: string;
  created_at: number;
}

function makeFakeDB(seed: FakeLedgerRow[] = []): {
  rows: FakeLedgerRow[];
  binding: D1Database;
} {
  const rows = [...seed];
  const db = {
    prepare(_query: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async run() {
          // INSERT OR IGNORE: skip if webhook_id already present.
          const [id, webhook_id, event_type, polar_object_id, polar_customer_id,
                polar_user_id, amount_cents, currency, status, meta_json, created_at] =
            bound as [string, string, string, string | null, string | null,
                       string | null, number | null, string | null, string, string, number];
          const exists = rows.some((r) => r.webhook_id === webhook_id);
          if (exists) return { meta: { changes: 0 } };
          rows.push({ id, webhook_id, event_type, polar_object_id, polar_customer_id,
                       polar_user_id, amount_cents, currency, status, meta_json, created_at });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { rows, binding: db };
}

const NOW = 1_700_000_000;
const WH_ID = 'msg_01HV2EXAMPLE';

async function makeHeaders(body: string, now = NOW, id = WH_ID): Promise<Record<string, string>> {
  const sig = await signBody(id, now, body);
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(now),
    'webhook-signature': `v1,${sig}`,
  };
}

function buildApp(now: number) {
  const app = new Hono<{ Bindings: { DB: D1Database; POLAR_WEBHOOK_SECRET?: string } }>();
  app.post('/api/webhooks/polar', handlePolarWebhook({ now: () => now, newId: () => 'test-id' }));
  return app;
}

// ---------------------------------------------------------------------------
// verifyPolarSignature unit tests
// ---------------------------------------------------------------------------

describe('verifyPolarSignature', () => {
  it('accepts a fresh, well-signed payload', async () => {
    const body = '{"type":"order.created","data":{}}';
    const sig = await signBody(WH_ID, NOW, body);
    const result = await verifyPolarSignature(
      body, WH_ID, String(NOW), `v1,${sig}`, SECRET, NOW,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts when secret has no whsec_ prefix', async () => {
    const body = '{}';
    const sig = await signBody(WH_ID, NOW, body);
    const result = await verifyPolarSignature(
      body, WH_ID, String(NOW), `v1,${sig}`, SECRET_B64, NOW,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts a Polar "polar_whs_" prefixed secret', async () => {
    const body = '{}';
    const sig = await signBody(WH_ID, NOW, body);
    const result = await verifyPolarSignature(
      body, WH_ID, String(NOW), `v1,${sig}`, `polar_whs_${SECRET_B64}`, NOW,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts one matching sig among multiple (key rotation)', async () => {
    const body = '{}';
    const sig = await signBody(WH_ID, NOW, body);
    const result = await verifyPolarSignature(
      body, WH_ID, String(NOW), `v1,aaaaaa== v1,${sig}`, SECRET, NOW,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects missing headers', async () => {
    const result = await verifyPolarSignature('{}', null, null, null, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects when only some headers are missing', async () => {
    const result = await verifyPolarSignature('{}', WH_ID, null, 'v1,abc', SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a stale timestamp (too old)', async () => {
    const body = '{}';
    const sig = await signBody(WH_ID, NOW, body);
    const result = await verifyPolarSignature(
      body, WH_ID, String(NOW), `v1,${sig}`, SECRET, NOW + 60 * 60,
    );
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a non-numeric timestamp', async () => {
    const result = await verifyPolarSignature('{}', WH_ID, 'banana', 'v1,abc', SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a wrong signature', async () => {
    const body = '{"type":"order.created","data":{}}';
    const sig = await signBody(WH_ID, NOW, body);
    // tamper with body after signing
    const result = await verifyPolarSignature(
      body + ' ', WH_ID, String(NOW), `v1,${sig}`, SECRET, NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a malformed secret (bad base64)', async () => {
    const result = await verifyPolarSignature(
      '{}', WH_ID, String(NOW), 'v1,abc', 'whsec_!!!notbase64', NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'malformed_secret' });
  });

  it('rejects a signature header with no v1 entries', async () => {
    const result = await verifyPolarSignature(
      '{}', WH_ID, String(NOW), 'v2,abc', SECRET, NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

// ---------------------------------------------------------------------------
// handlePolarWebhook integration tests
// ---------------------------------------------------------------------------

describe('handlePolarWebhook', () => {
  it('returns 503 when the secret is not configured', async () => {
    const app = buildApp(NOW);
    const { binding } = makeFakeDB();
    const res = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      { DB: binding },
    );
    expect(res.status).toBe(503);
  });

  it('returns 401 for invalid signature', async () => {
    const app = buildApp(NOW);
    const { binding } = makeFakeDB();
    const res = await app.request(
      '/api/webhooks/polar',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': WH_ID,
          'webhook-timestamp': String(NOW),
          'webhook-signature': 'v1,AAAA',
        },
        body: '{"type":"order.created","data":{}}',
      },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    const json = await res.json() as { reason: string };
    expect(json.reason).toBe('bad_signature');
  });

  it('returns 400 for malformed JSON', async () => {
    const app = buildApp(NOW);
    const { binding } = makeFakeDB();
    const body = 'not json';
    const headers = await makeHeaders(body);
    const res = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(400);
  });

  it('inserts an order.created event and returns inserted: true', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'order.created',
      data: { id: 'ord_123', amount: 999, currency: 'usd', customer_id: 'cus_abc' },
    });
    const headers = await makeHeaders(payload);
    const res = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; inserted: boolean; event_type: string };
    expect(json).toMatchObject({ ok: true, inserted: true, event_type: 'order.created' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].amount_cents).toBe(999);
    expect(rows[0].currency).toBe('usd');
    expect(rows[0].polar_customer_id).toBe('cus_abc');
    expect(rows[0].polar_object_id).toBe('ord_123');
  });

  it('is idempotent — duplicate webhook_id returns inserted: false', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'order.created',
      data: { id: 'ord_123', amount: 999, currency: 'usd' },
    });
    const headers = await makeHeaders(payload);
    const env = { DB: binding, POLAR_WEBHOOK_SECRET: SECRET };

    const first = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      env,
    );
    const second = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rows).toHaveLength(1);
    const json = await second.json() as { inserted: boolean };
    expect(json.inserted).toBe(false);
  });

  it('maps subscription.active → status active', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'subscription.active',
      data: { id: 'sub_xyz', amount: 500, currency: 'usd', customer_id: 'cus_abc' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('active');
  });

  it('maps subscription.cancelled → status cancelled', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'subscription.cancelled',
      data: { id: 'sub_xyz', customer_id: 'cus_abc' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('cancelled');
  });

  it('maps subscription.revoked → status revoked', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'subscription.revoked',
      data: { id: 'sub_xyz' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('revoked');
  });

  it('maps refund.created → status refunded, stores positive amount', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'refund.created',
      data: { id: 'ref_001', amount: 999, net_amount: 980, currency: 'usd', order_id: 'ord_123' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('refunded');
    // net_amount takes priority for refunds
    expect(rows[0].amount_cents).toBe(980);
  });

  it('maps benefit_grant.revoked → status revoked with null amount', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'benefit_grant.revoked',
      data: { id: 'bg_001', benefit_id: 'ben_pro', customer_id: 'cus_abc' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].amount_cents).toBeNull();
  });

  it('maps a dispute event → status disputed', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'charge.dispute.created',
      data: { id: 'dis_001', amount: 999, currency: 'usd' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('disputed');
  });

  it('falls back to data.status for subscription.updated', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'subscription.updated',
      data: { id: 'sub_xyz', status: 'past_due', amount: 500, currency: 'usd' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].status).toBe('failed');
  });

  it('stores full data object in meta_json', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const data = { id: 'ord_999', amount: 1200, currency: 'eur', extra_field: 'keep me' };
    const payload = JSON.stringify({ type: 'order.paid', data });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(JSON.parse(rows[0].meta_json)).toMatchObject(data);
  });

  it('stores polar_user_id from data.user_id when present', async () => {
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const payload = JSON.stringify({
      type: 'order.paid',
      data: { id: 'ord_1', amount: 500, currency: 'usd', user_id: 'polar_usr_abc' },
    });
    const headers = await makeHeaders(payload);
    await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(rows[0].polar_user_id).toBe('polar_usr_abc');
  });

  it('accepts metadata with non-string values (numbers/booleans)', async () => {
    // Polar echoes metadata back with original JSON types; the schema must not
    // reject numbers/booleans or it 400s and Polar retries the webhook forever.
    const app = buildApp(NOW);
    const { rows, binding } = makeFakeDB();
    const data = {
      id: 'ord_meta',
      amount: 500,
      currency: 'usd',
      metadata: { creator_user_id: 'u_1', kind: 'tip', video_id: 42, gift: true },
    };
    const payload = JSON.stringify({ type: 'order.paid', data });
    const headers = await makeHeaders(payload);
    const res = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', headers, body: payload },
      { DB: binding, POLAR_WEBHOOK_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { inserted: boolean };
    expect(json.inserted).toBe(true);
    expect(JSON.parse(rows[0].meta_json).metadata).toMatchObject({ video_id: 42, gift: true });
  });
});
