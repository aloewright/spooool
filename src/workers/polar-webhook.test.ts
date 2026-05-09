import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { handlePolarWebhook, type PolarWebhookEnv } from './polar-webhook';
import { signWebhookForTest } from './polar';

const SECRET = 'test-polar-secret';

interface LedgerRow {
  id: string;
  polar_event_id: string;
  kind: string;
  creator_user_id: string;
  payer_user_id: string | null;
  video_id: string | null;
  membership_id: string | null;
  gross_amount_cents: number;
  platform_fee_cents: number;
  net_amount_cents: number;
  currency: string;
  occurred_at: number;
  metadata: string | null;
}

interface MembershipRow {
  id: string;
  polar_subscription_id: string;
  tier_id: string;
  creator_user_id: string;
  subscriber_user_id: string;
  status: string;
  current_period_end: number | null;
  canceled_at: number | null;
  created_at: number;
  updated_at: number;
}

interface PayoutRow {
  id: string;
  polar_payout_id: string;
  creator_user_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  arrival_date: number | null;
  created_at: number;
  updated_at: number;
}

interface AccountRow {
  user_id: string;
  polar_account_id: string;
  status: string;
  payouts_enabled: number;
}

interface PolarEventRow {
  id: string;
  event_type: string;
  payload: string;
  received_at: number;
  processed_at: number | null;
  process_error: string | null;
}

interface FakeStore {
  events: Map<string, PolarEventRow>;
  ledger: Map<string, LedgerRow>;
  memberships: Map<string, MembershipRow>;
  payouts: Map<string, PayoutRow>;
  accounts: Map<string, AccountRow>; // by polar_account_id
}

function makeStore(): FakeStore {
  return {
    events: new Map(),
    ledger: new Map(),
    memberships: new Map(),
    payouts: new Map(),
    accounts: new Map(),
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

function fakeDB(store: FakeStore): D1Database {
  const prepare = (sql: string): PreparedStmt => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api: PreparedStmt = {
      bind(...v) {
        bound = v;
        return api;
      },
      async first<T>() {
        if (trimmed.startsWith('SELECT user_id FROM creator_polar_accounts WHERE polar_account_id =')) {
          const acc = store.accounts.get(bound[0] as string);
          return (acc ? { user_id: acc.user_id } : null) as T | null;
        }
        if (trimmed.startsWith('SELECT id FROM memberships WHERE polar_subscription_id =')) {
          for (const m of store.memberships.values()) {
            if (m.polar_subscription_id === bound[0]) return { id: m.id } as T;
          }
          return null;
        }
        return null;
      },
      async run() {
        if (trimmed.startsWith('INSERT INTO polar_events')) {
          const [id, type, payload, receivedAt] = bound as [string, string, string, number];
          if (store.events.has(id)) return { meta: { changes: 0 } };
          store.events.set(id, {
            id,
            event_type: type,
            payload,
            received_at: receivedAt,
            processed_at: null,
            process_error: null,
          });
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('UPDATE polar_events SET processed_at')) {
          const [processedAt, error, id] = bound as [number, string | null, string];
          const evt = store.events.get(id);
          if (evt) {
            evt.processed_at = processedAt;
            evt.process_error = error;
          }
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('INSERT INTO monetization_ledger')) {
          const [
            id,
            polarEventId,
            kind,
            creatorUserId,
            payerUserId,
            videoId,
            membershipId,
            gross,
            fee,
            net,
            currency,
            occurredAt,
            metadata,
          ] = bound as [
            string,
            string,
            string,
            string,
            string | null,
            string | null,
            string | null,
            number,
            number,
            number,
            string,
            number,
            string | null,
          ];
          // ON CONFLICT DO NOTHING — keyed on polar_event_id
          for (const row of store.ledger.values()) {
            if (row.polar_event_id === polarEventId) {
              return { meta: { changes: 0 } };
            }
          }
          store.ledger.set(id, {
            id,
            polar_event_id: polarEventId,
            kind,
            creator_user_id: creatorUserId,
            payer_user_id: payerUserId,
            video_id: videoId,
            membership_id: membershipId,
            gross_amount_cents: gross,
            platform_fee_cents: fee,
            net_amount_cents: net,
            currency,
            occurred_at: occurredAt,
            metadata,
          });
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('INSERT INTO memberships')) {
          const [
            id,
            polarSubId,
            tierId,
            creatorUserId,
            subscriberUserId,
            status,
            periodEnd,
            canceledAt,
            createdAt,
            updatedAt,
          ] = bound as [
            string,
            string,
            string,
            string,
            string,
            string,
            number | null,
            number | null,
            number,
            number,
          ];
          // ON CONFLICT(polar_subscription_id) DO UPDATE
          for (const m of store.memberships.values()) {
            if (m.polar_subscription_id === polarSubId) {
              m.status = status;
              m.current_period_end = periodEnd;
              m.canceled_at = canceledAt;
              m.updated_at = updatedAt;
              return { meta: { changes: 1 } };
            }
          }
          store.memberships.set(id, {
            id,
            polar_subscription_id: polarSubId,
            tier_id: tierId,
            creator_user_id: creatorUserId,
            subscriber_user_id: subscriberUserId,
            status,
            current_period_end: periodEnd,
            canceled_at: canceledAt,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('INSERT INTO payouts')) {
          const [
            id,
            polarPayoutId,
            creatorUserId,
            amount,
            currency,
            status,
            arrivalDate,
            createdAt,
            updatedAt,
          ] = bound as [string, string, string, number, string, string, number | null, number, number];
          for (const p of store.payouts.values()) {
            if (p.polar_payout_id === polarPayoutId) {
              p.status = status;
              p.arrival_date = arrivalDate;
              p.updated_at = updatedAt;
              return { meta: { changes: 1 } };
            }
          }
          store.payouts.set(id, {
            id,
            polar_payout_id: polarPayoutId,
            creator_user_id: creatorUserId,
            amount_cents: amount,
            currency,
            status,
            arrival_date: arrivalDate,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('UPDATE creator_polar_accounts SET status')) {
          const [status, payoutsEnabled, _updatedAt, polarAccountId] = bound as [
            string,
            number,
            number,
            string,
          ];
          const acc = store.accounts.get(polarAccountId);
          if (acc) {
            acc.status = status;
            acc.payouts_enabled = payoutsEnabled;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return api;
  };
  return { prepare } as unknown as D1Database;
}

function buildApp(now: number) {
  const app = new Hono<{ Bindings: PolarWebhookEnv }>();
  app.post('/api/webhooks/polar', handlePolarWebhook({ now: () => now }));
  return app;
}

async function postEvent(
  app: Hono<{ Bindings: PolarWebhookEnv }>,
  env: PolarWebhookEnv,
  envelope: { type: string; data: unknown },
  now: number,
  options: { id?: string; secret?: string } = {},
) {
  const body = JSON.stringify(envelope);
  const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(now);
  const sig = await signWebhookForTest(body, id, ts, options.secret ?? SECRET);
  return app.request(
    '/api/webhooks/polar',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': ts,
        'webhook-signature': sig,
      },
      body,
    },
    env,
  );
}

describe('handlePolarWebhook', () => {
  it('returns 503 when the secret is not configured', async () => {
    const app = buildApp(1);
    const store = makeStore();
    const res = await app.request(
      '/api/webhooks/polar',
      { method: 'POST', body: '{}' },
      { DB: fakeDB(store) } as PolarWebhookEnv,
    );
    expect(res.status).toBe(503);
  });

  it('rejects an invalid signature with 401', async () => {
    const app = buildApp(1_700_000_000);
    const store = makeStore();
    const env: PolarWebhookEnv = { DB: fakeDB(store), POLAR_WEBHOOK_SECRET: SECRET };
    const res = await app.request(
      '/api/webhooks/polar',
      {
        method: 'POST',
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': '1700000000',
          'webhook-signature': 'v1,deadbeef',
        },
        body: '{"type":"order.created","data":{"id":"x"}}',
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('records an order event in the ledger with platform fee split', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
      POLAR_PLATFORM_FEE_BPS: '1000',
    };

    const res = await postEvent(app, env, {
      type: 'order.paid',
      data: {
        id: 'ord_1',
        amount: 1000,
        currency: 'usd',
        paid_at: '2024-01-01T00:00:00Z',
        metadata: {
          creator_user_id: 'creator_a',
          payer_user_id: 'viewer_b',
          video_id: 'v1',
        },
      },
    }, now);
    expect(res.status).toBe(200);
    const entries = [...store.ledger.values()];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tip',
      creator_user_id: 'creator_a',
      payer_user_id: 'viewer_b',
      video_id: 'v1',
      gross_amount_cents: 1000,
      platform_fee_cents: 100,
      net_amount_cents: 900,
      currency: 'USD',
    });
  });

  it('classifies orders with subscription_id as membership_payment', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
    };
    // Pre-seed a membership row so the order can join to it.
    store.memberships.set('m1', {
      id: 'm1',
      polar_subscription_id: 'sub_1',
      tier_id: 't1',
      creator_user_id: 'creator_a',
      subscriber_user_id: 'viewer_b',
      status: 'active',
      current_period_end: null,
      canceled_at: null,
      created_at: 0,
      updated_at: 0,
    });

    const res = await postEvent(app, env, {
      type: 'order.paid',
      data: {
        id: 'ord_2',
        amount: 500,
        currency: 'usd',
        subscription_id: 'sub_1',
        paid_at: '2024-01-01T00:00:00Z',
        metadata: { creator_user_id: 'creator_a', subscriber_user_id: 'viewer_b' },
      },
    }, now);
    expect(res.status).toBe(200);
    const entries = [...store.ledger.values()];
    expect(entries[0]).toMatchObject({
      kind: 'membership_payment',
      membership_id: 'm1',
    });
  });

  it('upserts a membership on subscription.created', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
    };

    const res = await postEvent(app, env, {
      type: 'subscription.created',
      data: {
        id: 'sub_x',
        status: 'active',
        current_period_end: '2024-02-01T00:00:00Z',
        metadata: {
          creator_user_id: 'creator_a',
          subscriber_user_id: 'viewer_b',
          tier_id: 'tier_1',
        },
      },
    }, now);
    expect(res.status).toBe(200);
    const m = [...store.memberships.values()][0];
    expect(m).toMatchObject({
      polar_subscription_id: 'sub_x',
      status: 'active',
      tier_id: 'tier_1',
      creator_user_id: 'creator_a',
      subscriber_user_id: 'viewer_b',
    });
  });

  it('marks membership canceled on subscription.canceled', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    store.memberships.set('m1', {
      id: 'm1',
      polar_subscription_id: 'sub_x',
      tier_id: 'tier_1',
      creator_user_id: 'creator_a',
      subscriber_user_id: 'viewer_b',
      status: 'active',
      current_period_end: null,
      canceled_at: null,
      created_at: 0,
      updated_at: 0,
    });
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
    };

    const res = await postEvent(app, env, {
      type: 'subscription.canceled',
      data: {
        id: 'sub_x',
        status: 'canceled',
        canceled_at: '2024-01-15T00:00:00Z',
        metadata: {
          creator_user_id: 'creator_a',
          subscriber_user_id: 'viewer_b',
          tier_id: 'tier_1',
        },
      },
    }, now);
    expect(res.status).toBe(200);
    const m = store.memberships.get('m1');
    expect(m?.status).toBe('canceled');
    expect(m?.canceled_at).toBeGreaterThan(0);
  });

  it('records a payout when account is known', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    store.accounts.set('acc_1', {
      user_id: 'creator_a',
      polar_account_id: 'acc_1',
      status: 'active',
      payouts_enabled: 1,
    });
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
    };

    const res = await postEvent(app, env, {
      type: 'payout.paid',
      data: {
        id: 'po_1',
        account_id: 'acc_1',
        amount: 5000,
        currency: 'usd',
        status: 'paid',
        arrival_date: '2024-01-20T00:00:00Z',
      },
    }, now);
    expect(res.status).toBe(200);
    const p = [...store.payouts.values()][0];
    expect(p).toMatchObject({
      polar_payout_id: 'po_1',
      creator_user_id: 'creator_a',
      amount_cents: 5000,
      status: 'paid',
    });
  });

  it('updates account state on account.updated', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    store.accounts.set('acc_1', {
      user_id: 'creator_a',
      polar_account_id: 'acc_1',
      status: 'pending',
      payouts_enabled: 0,
    });
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
    };
    const res = await postEvent(app, env, {
      type: 'account.updated',
      data: { id: 'acc_1', status: 'active', payouts_enabled: true },
    }, now);
    expect(res.status).toBe(200);
    const a = store.accounts.get('acc_1');
    expect(a?.status).toBe('active');
    expect(a?.payouts_enabled).toBe(1);
  });

  it('ignores a redelivered webhook (same webhook-id)', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
      POLAR_PLATFORM_FEE_BPS: '1000',
    };
    const envelope = {
      type: 'order.paid',
      data: {
        id: 'ord_1',
        amount: 1000,
        currency: 'usd',
        paid_at: '2024-01-01T00:00:00Z',
        metadata: { creator_user_id: 'creator_a', video_id: 'v1' },
      },
    };
    const first = await postEvent(app, env, envelope, now, { id: 'msg_dup' });
    const second = await postEvent(app, env, envelope, now, { id: 'msg_dup' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect([...store.ledger.values()]).toHaveLength(1);
  });

  it('records process_error when dispatch fails (missing creator metadata)', async () => {
    const now = 1_700_000_000;
    const app = buildApp(now);
    const store = makeStore();
    const env: PolarWebhookEnv = {
      DB: fakeDB(store),
      POLAR_WEBHOOK_SECRET: SECRET,
    };
    const res = await postEvent(app, env, {
      type: 'order.paid',
      data: { id: 'ord_orphan', amount: 100, currency: 'usd' },
    }, now);
    // Still 200 — the audit row is in polar_events with the error.
    expect(res.status).toBe(200);
    const evt = [...store.events.values()][0];
    expect(evt.process_error).toBeTruthy();
    expect([...store.ledger.values()]).toHaveLength(0);
  });
});
