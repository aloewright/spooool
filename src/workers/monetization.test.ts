import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { monetizationRoutes, type MonetizationEnv } from './monetization';

interface AccountRow {
  user_id: string;
  polar_account_id: string;
  status: string;
  onboarding_url: string | null;
  payouts_enabled: number;
}

interface TierRow {
  id: string;
  creator_user_id: string;
  polar_product_id: string | null;
  polar_price_id: string | null;
  name: string;
  description: string;
  amount_cents: number;
  currency: string;
  interval: string;
  archived_at: number | null;
}

interface VideoRow {
  id: string;
  creator_user_id: string;
  creator_username: string;
  deleted_at: string | null;
}

interface UserRow {
  id: string;
  username: string;
}

interface MembershipRow {
  id: string;
  tier_id: string;
  creator_user_id: string;
  subscriber_user_id: string;
  status: string;
  current_period_end: number | null;
  canceled_at: number | null;
  created_at: number;
}

interface LedgerRow {
  creator_user_id: string;
  kind: string;
  gross_amount_cents: number;
  platform_fee_cents: number;
  net_amount_cents: number;
  currency: string;
  occurred_at: number;
}

interface PayoutRow {
  polar_payout_id: string;
  creator_user_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  arrival_date: number | null;
  created_at: number;
}

interface FakeStore {
  accounts: Map<string, AccountRow>; // by user_id
  tiers: Map<string, TierRow>;
  users: Map<string, UserRow>; // by username
  videos: Map<string, VideoRow>;
  memberships: MembershipRow[];
  ledger: LedgerRow[];
  payouts: PayoutRow[];
}

function makeStore(): FakeStore {
  return {
    accounts: new Map(),
    tiers: new Map(),
    users: new Map(),
    videos: new Map(),
    memberships: [],
    ledger: [],
    payouts: [],
  };
}

interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

function fakeDB(store: FakeStore): D1Database {
  const prepare = (sql: string): Stmt => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api: Stmt = {
      bind(...v) {
        bound = v;
        return api;
      },
      async first<T>() {
        if (
          trimmed.startsWith(
            'SELECT polar_account_id, status, onboarding_url, payouts_enabled FROM creator_polar_accounts WHERE user_id =',
          )
        ) {
          const a = store.accounts.get(bound[0] as string);
          if (!a) return null;
          return {
            polar_account_id: a.polar_account_id,
            status: a.status,
            onboarding_url: a.onboarding_url,
            payouts_enabled: a.payouts_enabled,
          } as T;
        }
        if (trimmed.startsWith('SELECT status, payouts_enabled FROM creator_polar_accounts WHERE user_id =')) {
          const a = store.accounts.get(bound[0] as string);
          return (a ? { status: a.status, payouts_enabled: a.payouts_enabled } : null) as T | null;
        }
        if (trimmed.startsWith('SELECT id FROM user WHERE username =')) {
          const u = store.users.get(bound[0] as string);
          return (u ? { id: u.id } : null) as T | null;
        }
        if (trimmed.startsWith('SELECT id, creator_user_id, polar_price_id, polar_product_id FROM membership_tiers WHERE id =')) {
          const t = store.tiers.get(bound[0] as string);
          if (!t || t.archived_at) return null;
          return {
            id: t.id,
            creator_user_id: t.creator_user_id,
            polar_price_id: t.polar_price_id,
            polar_product_id: t.polar_product_id,
          } as T;
        }
        if (
          trimmed.startsWith(
            'SELECT v.id, v.user_id AS creator_user_id, u.username AS creator_username FROM videos v',
          )
        ) {
          const v = store.videos.get(bound[0] as string);
          if (!v || v.deleted_at) return null;
          return {
            id: v.id,
            creator_user_id: v.creator_user_id,
            creator_username: v.creator_username,
          } as T;
        }
        if (trimmed.startsWith('SELECT COALESCE(SUM(gross_amount_cents)')) {
          const creator = bound[0] as string;
          let gross = 0,
            fee = 0,
            net = 0,
            entries = 0;
          for (const e of store.ledger) {
            if (e.creator_user_id === creator) {
              gross += e.gross_amount_cents;
              fee += e.platform_fee_cents;
              net += e.net_amount_cents;
              entries++;
            }
          }
          return { gross, fee, net, entries } as T;
        }
        return null;
      },
      async all<T>() {
        if (
          trimmed.startsWith(
            'SELECT id, name, description, amount_cents, currency, interval FROM membership_tiers WHERE creator_user_id =',
          )
        ) {
          const creator = bound[0] as string;
          const out: TierRow[] = [];
          for (const t of store.tiers.values()) {
            if (t.creator_user_id === creator && t.archived_at == null) out.push(t);
          }
          out.sort((a, b) => a.amount_cents - b.amount_cents);
          return { results: out as unknown as T[] };
        }
        if (trimmed.startsWith('SELECT m.id, m.tier_id, m.status')) {
          const subscriber = bound[0] as string;
          const out = store.memberships
            .filter((m) => m.subscriber_user_id === subscriber)
            .map((m) => ({ id: m.id, tier_id: m.tier_id, status: m.status }));
          return { results: out as unknown as T[] };
        }
        if (trimmed.startsWith('SELECT id, kind, gross_amount_cents')) {
          const creator = bound[0] as string;
          return {
            results: store.ledger.filter((l) => l.creator_user_id === creator) as unknown as T[],
          };
        }
        if (trimmed.startsWith('SELECT polar_payout_id, amount_cents')) {
          const creator = bound[0] as string;
          return {
            results: store.payouts.filter((p) => p.creator_user_id === creator) as unknown as T[],
          };
        }
        return { results: [] };
      },
      async run() {
        if (trimmed.startsWith('UPDATE membership_tiers SET archived_at')) {
          const [archivedAt, _updatedAt, tierId, creatorId] = bound as [number, number, string, string];
          const t = store.tiers.get(tierId);
          if (t && t.creator_user_id === creatorId && t.archived_at == null) {
            t.archived_at = archivedAt;
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

function buildApp(env: MonetizationEnv, user: { id: string; email: string; name: string } | null) {
  const app = new Hono<{ Bindings: MonetizationEnv; Variables: { user: typeof user } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', monetizationRoutes);
  const send = (path: string, init?: RequestInit) => app.request(path, init, env);
  return { app, env, request: send };
}

describe('monetization onboarding', () => {
  it('rejects anonymous callers with 401', async () => {
    const store = makeStore();
    const { request } = buildApp({ DB: fakeDB(store) }, null);
    const res = await request('/api/monetization/onboarding/status');
    expect(res.status).toBe(401);
  });

  it('returns not_started when no row exists', async () => {
    const store = makeStore();
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/onboarding/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'not_started' });
  });

  it('returns the existing onboarding row', async () => {
    const store = makeStore();
    store.accounts.set('u1', {
      user_id: 'u1',
      polar_account_id: 'acc_x',
      status: 'pending',
      onboarding_url: 'https://polar.example/onboarding/abc',
      payouts_enabled: 0,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/onboarding/status');
    const body = await res.json();
    expect(body).toMatchObject({
      accountId: 'acc_x',
      status: 'pending',
      onboardingUrl: 'https://polar.example/onboarding/abc',
      payoutsEnabled: false,
    });
  });
});

describe('public tier listing', () => {
  it('returns 404 for an unknown channel', async () => {
    const store = makeStore();
    const { request } = buildApp({ DB: fakeDB(store) }, null);
    const res = await request('/api/monetization/channels/nobody/tiers');
    expect(res.status).toBe(404);
  });

  it('returns active tiers ordered by price', async () => {
    const store = makeStore();
    store.users.set('alice', { id: 'u1', username: 'alice' });
    store.tiers.set('t1', {
      id: 't1',
      creator_user_id: 'u1',
      polar_product_id: 'p1',
      polar_price_id: 'pr1',
      name: 'Bronze',
      description: '',
      amount_cents: 500,
      currency: 'USD',
      interval: 'month',
      archived_at: null,
    });
    store.tiers.set('t2', {
      id: 't2',
      creator_user_id: 'u1',
      polar_product_id: 'p2',
      polar_price_id: 'pr2',
      name: 'Gold',
      description: '',
      amount_cents: 2500,
      currency: 'USD',
      interval: 'month',
      archived_at: null,
    });
    const { request } = buildApp({ DB: fakeDB(store) }, null);
    const res = await request('/api/monetization/channels/alice/tiers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tiers: { name: string; amountCents: number }[] };
    expect(body.tiers.map((t) => t.name)).toEqual(['Bronze', 'Gold']);
  });
});

describe('tier creation gating', () => {
  it('rejects unauthenticated', async () => {
    const store = makeStore();
    const { request } = buildApp({ DB: fakeDB(store) }, null);
    const res = await request('/api/monetization/tiers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bronze', amountCents: 500 }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses creation when onboarding is not active', async () => {
    const store = makeStore();
    store.accounts.set('u1', {
      user_id: 'u1',
      polar_account_id: 'acc',
      status: 'pending',
      onboarding_url: 'https://x',
      payouts_enabled: 0,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/tiers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bronze', amountCents: 500 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('onboarding_incomplete');
  });

  it('rejects malformed bodies with 400', async () => {
    const store = makeStore();
    store.accounts.set('u1', {
      user_id: 'u1',
      polar_account_id: 'acc',
      status: 'active',
      onboarding_url: null,
      payouts_enabled: 1,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/tiers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', amountCents: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('tier archive', () => {
  it('archives a tier owned by the caller', async () => {
    const store = makeStore();
    store.tiers.set('t1', {
      id: 't1',
      creator_user_id: 'u1',
      polar_product_id: 'p1',
      polar_price_id: 'pr1',
      name: 'Bronze',
      description: '',
      amount_cents: 500,
      currency: 'USD',
      interval: 'month',
      archived_at: null,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/tiers/t1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.tiers.get('t1')?.archived_at).toBeGreaterThan(0);
  });

  it('refuses to archive someone else\'s tier', async () => {
    const store = makeStore();
    store.tiers.set('t1', {
      id: 't1',
      creator_user_id: 'other_user',
      polar_product_id: 'p1',
      polar_price_id: 'pr1',
      name: 'Bronze',
      description: '',
      amount_cents: 500,
      currency: 'USD',
      interval: 'month',
      archived_at: null,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/tiers/t1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(store.tiers.get('t1')?.archived_at).toBeNull();
  });
});

describe('membership checkout gating', () => {
  it('rejects subscribing to your own tier', async () => {
    const store = makeStore();
    store.tiers.set('t1', {
      id: 't1',
      creator_user_id: 'u1',
      polar_product_id: 'p1',
      polar_price_id: 'pr1',
      name: 'Bronze',
      description: '',
      amount_cents: 500,
      currency: 'USD',
      interval: 'month',
      archived_at: null,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/memberships/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tierId: 't1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the tier is missing its Polar price', async () => {
    const store = makeStore();
    store.tiers.set('t1', {
      id: 't1',
      creator_user_id: 'creator',
      polar_product_id: 'p1',
      polar_price_id: null,
      name: 'Bronze',
      description: '',
      amount_cents: 500,
      currency: 'USD',
      interval: 'month',
      archived_at: null,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/memberships/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tierId: 't1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('tier_unprovisioned');
  });
});

describe('tip checkout gating', () => {
  it('rejects tipping your own video', async () => {
    const store = makeStore();
    store.videos.set('v1', {
      id: 'v1',
      creator_user_id: 'u1',
      creator_username: 'alice',
      deleted_at: null,
    });
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/tips/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'v1', amountCents: 500 }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses when the creator has no active onboarding', async () => {
    const store = makeStore();
    store.videos.set('v1', {
      id: 'v1',
      creator_user_id: 'creator',
      creator_username: 'creator',
      deleted_at: null,
    });
    // No creator_polar_accounts row → 409
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'u1', email: 'a@b.c', name: 'Alice' },
    );
    const res = await request('/api/monetization/tips/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'v1', amountCents: 500 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('creator_not_onboarded');
  });
});

describe('payouts dashboard', () => {
  it('returns zero totals when no ledger entries exist', async () => {
    const store = makeStore();
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'creator', email: 'c@b.c', name: 'Creator' },
    );
    const res = await request('/api/monetization/me/payouts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { grossCents: number; netCents: number; entryCount: number };
      ledger: unknown[];
      payouts: unknown[];
    };
    expect(body.totals).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      netCents: 0,
      entryCount: 0,
    });
    expect(body.ledger).toEqual([]);
    expect(body.payouts).toEqual([]);
  });

  it('aggregates ledger entries owned by the creator', async () => {
    const store = makeStore();
    store.ledger.push(
      {
        creator_user_id: 'creator',
        kind: 'tip',
        gross_amount_cents: 1000,
        platform_fee_cents: 100,
        net_amount_cents: 900,
        currency: 'USD',
        occurred_at: 1,
      },
      {
        creator_user_id: 'creator',
        kind: 'membership_payment',
        gross_amount_cents: 500,
        platform_fee_cents: 50,
        net_amount_cents: 450,
        currency: 'USD',
        occurred_at: 2,
      },
      {
        // belongs to a different creator — must not be counted
        creator_user_id: 'someone_else',
        kind: 'tip',
        gross_amount_cents: 9999,
        platform_fee_cents: 999,
        net_amount_cents: 9000,
        currency: 'USD',
        occurred_at: 3,
      },
    );
    const { request } = buildApp(
      { DB: fakeDB(store) },
      { id: 'creator', email: 'c@b.c', name: 'Creator' },
    );
    const res = await request('/api/monetization/me/payouts');
    const body = (await res.json()) as {
      totals: { grossCents: number; platformFeeCents: number; netCents: number; entryCount: number };
    };
    expect(body.totals).toEqual({
      grossCents: 1500,
      platformFeeCents: 150,
      netCents: 1350,
      entryCount: 2,
    });
  });
});
