import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { payoutsRoutes, type PayoutsEnv } from './payouts';

type SessionUser = { id: string } | null;

function buildApp(env: PayoutsEnv, user: SessionUser = null) {
  const app = new Hono<{ Bindings: PayoutsEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', payoutsRoutes);
  return (path: string, init?: RequestInit) => app.request(path, init, env);
}

// ---------------------------------------------------------------------------
// Fake D1 builder
// ---------------------------------------------------------------------------

interface FakeDBOpts {
  totalEarned?: number;
  fees?: number;
  paidOut?: number;
  pendingLocal?: number;
  polarAccountId?: string | null;
  transactions?: Array<{
    id: string; kind: string; amount_cents: number; platform_fee_cents: number;
    currency: string; description: string | null; created_at: string;
  }>;
  payouts?: Array<{
    id: string; amount_cents: number; currency: string; status: string;
    polar_payout_id: string | null; paid_at: string | null; created_at: string;
  }>;
}

function fakeDB(opts: FakeDBOpts = {}): D1Database {
  const {
    totalEarned = 0,
    fees = 0,
    paidOut = 0,
    pendingLocal = 0,
    polarAccountId = null,
    transactions = [],
    payouts = [],
  } = opts;

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first() {
          void bound;
          if (sql.includes('FROM creator_earnings') && sql.includes('SUM(amount_cents)')) {
            return { total: totalEarned, fees };
          }
          if (sql.includes("status = 'paid'")) {
            return { total: paidOut };
          }
          if (sql.includes('status IN')) {
            return { total: pendingLocal };
          }
          if (sql.includes('polar_account_id') && sql.includes('FROM user')) {
            return polarAccountId != null ? { polar_account_id: polarAccountId } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM creator_earnings') && sql.includes('LIMIT')) {
            return { results: transactions };
          }
          if (sql.includes('FROM creator_payouts') && sql.includes('LIMIT')) {
            return { results: payouts };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return db;
}

// ---------------------------------------------------------------------------
// GET /api/payouts/summary
// ---------------------------------------------------------------------------

describe('GET /api/payouts/summary', () => {
  it('returns 401 when not signed in', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/payouts/summary');
    expect(res.status).toBe(401);
  });

  it('returns zero totals when creator has no earnings', async () => {
    const req = buildApp({ DB: fakeDB() }, { id: 'u1' });
    const res = await req('/api/payouts/summary');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total_earned_cents: number;
      fees_cents: number;
      net_earned_cents: number;
      paid_out_cents: number;
      pending_payout_cents: number;
      polar_live: boolean;
    };
    expect(body.total_earned_cents).toBe(0);
    expect(body.fees_cents).toBe(0);
    expect(body.net_earned_cents).toBe(0);
    expect(body.paid_out_cents).toBe(0);
    expect(body.pending_payout_cents).toBe(0);
    expect(body.polar_live).toBe(false);
  });

  it('calculates net_earned_cents as total minus fees', async () => {
    const req = buildApp(
      { DB: fakeDB({ totalEarned: 10000, fees: 1000, paidOut: 0, pendingLocal: 0 }) },
      { id: 'u1' },
    );
    const res = await req('/api/payouts/summary');
    expect(res.status).toBe(200);
    const body = await res.json() as { total_earned_cents: number; fees_cents: number; net_earned_cents: number };
    expect(body.total_earned_cents).toBe(10000);
    expect(body.fees_cents).toBe(1000);
    expect(body.net_earned_cents).toBe(9000);
  });

  it('falls back to D1 pending sum when no Polar token is configured', async () => {
    const req = buildApp(
      { DB: fakeDB({ pendingLocal: 2500 }) },
      { id: 'u1' },
    );
    const res = await req('/api/payouts/summary');
    const body = await res.json() as { pending_payout_cents: number; polar_live: boolean };
    expect(body.pending_payout_cents).toBe(2500);
    expect(body.polar_live).toBe(false);
  });

  it('uses Polar live balance when token and account_id are present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        balance: { amount: 7500, currency: 'usd' },
        payout_amount: { amount: 7000, currency: 'usd' },
      }),
    }));
    const req = buildApp(
      { DB: fakeDB({ pendingLocal: 100, polarAccountId: 'acct_123' }), POLAR_ACCESS_TOKEN: 'tok' },
      { id: 'u1' },
    );
    const res = await req('/api/payouts/summary');
    const body = await res.json() as { pending_payout_cents: number; polar_live: boolean; currency: string };
    expect(body.pending_payout_cents).toBe(7500);
    expect(body.polar_live).toBe(true);
    expect(body.currency).toBe('usd');
    vi.unstubAllGlobals();
  });

  it('falls back to D1 when Polar API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const req = buildApp(
      { DB: fakeDB({ pendingLocal: 300, polarAccountId: 'acct_123' }), POLAR_ACCESS_TOKEN: 'tok' },
      { id: 'u1' },
    );
    const res = await req('/api/payouts/summary');
    const body = await res.json() as { pending_payout_cents: number; polar_live: boolean };
    expect(body.pending_payout_cents).toBe(300);
    expect(body.polar_live).toBe(false);
    vi.unstubAllGlobals();
  });

  it('skips Polar fetch when no polar_account_id is stored', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const req = buildApp(
      { DB: fakeDB({ pendingLocal: 100, polarAccountId: null }), POLAR_ACCESS_TOKEN: 'tok' },
      { id: 'u1' },
    );
    await req('/api/payouts/summary');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// GET /api/payouts/transactions
// ---------------------------------------------------------------------------

describe('GET /api/payouts/transactions', () => {
  it('returns 401 when not signed in', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/payouts/transactions');
    expect(res.status).toBe(401);
  });

  it('returns empty transactions list', async () => {
    const req = buildApp({ DB: fakeDB({ transactions: [] }) }, { id: 'u1' });
    const res = await req('/api/payouts/transactions');
    expect(res.status).toBe(200);
    const body = await res.json() as { transactions: unknown[] };
    expect(body.transactions).toEqual([]);
  });

  it('returns recent transactions', async () => {
    const txns = [
      { id: 't1', kind: 'tip', amount_cents: 500, platform_fee_cents: 50, currency: 'usd', description: 'Tip on video v1', created_at: '2024-01-01' },
      { id: 't2', kind: 'membership', amount_cents: 1000, platform_fee_cents: 100, currency: 'usd', description: 'Membership payment', created_at: '2024-01-02' },
    ];
    const req = buildApp({ DB: fakeDB({ transactions: txns }) }, { id: 'u1' });
    const res = await req('/api/payouts/transactions');
    expect(res.status).toBe(200);
    const body = await res.json() as { transactions: typeof txns };
    expect(body.transactions).toHaveLength(2);
    expect(body.transactions[0].kind).toBe('tip');
    expect(body.transactions[1].kind).toBe('membership');
  });

  it('returns 400 for invalid query params', async () => {
    const req = buildApp({ DB: fakeDB() }, { id: 'u1' });
    const res = await req('/api/payouts/transactions?limit=9999'); // exceeds max 100
    expect(res.status).toBe(400);
  });

  it('accepts valid limit param', async () => {
    const req = buildApp({ DB: fakeDB({ transactions: [] }) }, { id: 'u1' });
    const res = await req('/api/payouts/transactions?limit=10');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/payouts/history
// ---------------------------------------------------------------------------

describe('GET /api/payouts/history', () => {
  it('returns 401 when not signed in', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/payouts/history');
    expect(res.status).toBe(401);
  });

  it('returns empty payout history', async () => {
    const req = buildApp({ DB: fakeDB({ payouts: [] }) }, { id: 'u1' });
    const res = await req('/api/payouts/history');
    expect(res.status).toBe(200);
    const body = await res.json() as { payouts: unknown[]; polar_payouts: unknown[] };
    expect(body.payouts).toEqual([]);
    expect(body.polar_payouts).toEqual([]);
  });

  it('returns local payouts from D1', async () => {
    const payouts = [
      { id: 'po1', amount_cents: 5000, currency: 'usd', status: 'paid', polar_payout_id: 'po_abc', paid_at: '2024-01-10', created_at: '2024-01-01' },
    ];
    const req = buildApp({ DB: fakeDB({ payouts }) }, { id: 'u1' });
    const res = await req('/api/payouts/history');
    expect(res.status).toBe(200);
    const body = await res.json() as { payouts: typeof payouts; polar_payouts: unknown[] };
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts[0].status).toBe('paid');
    expect(body.polar_payouts).toEqual([]);
  });

  it('augments with live Polar payout data when token and account are present', async () => {
    const polarItems = [
      { id: 'po_live_1', type: 'payout', amount: 3000, currency: 'usd', created_at: '2024-02-01' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: polarItems, pagination: { total_count: 1, max_page: 1 } }),
    }));
    const req = buildApp(
      { DB: fakeDB({ payouts: [], polarAccountId: 'acct_123' }), POLAR_ACCESS_TOKEN: 'tok' },
      { id: 'u1' },
    );
    const res = await req('/api/payouts/history');
    const body = await res.json() as { payouts: unknown[]; polar_payouts: typeof polarItems };
    expect(body.polar_payouts).toHaveLength(1);
    expect(body.polar_payouts[0].id).toBe('po_live_1');
    vi.unstubAllGlobals();
  });

  it('returns empty polar_payouts when Polar fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const req = buildApp(
      { DB: fakeDB({ payouts: [], polarAccountId: 'acct_123' }), POLAR_ACCESS_TOKEN: 'tok' },
      { id: 'u1' },
    );
    const res = await req('/api/payouts/history');
    expect(res.status).toBe(200);
    const body = await res.json() as { polar_payouts: unknown[] };
    expect(body.polar_payouts).toEqual([]);
    vi.unstubAllGlobals();
  });
});
