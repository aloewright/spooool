import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  EARNINGS_YEAR_WINDOW,
  deriveIssuance,
  earningsRoutes,
  loadPayoutTotals,
  type EarningsEnv,
} from './earnings';

type RouteCtx = {
  Variables: { user: { id: string; email: string; name: string } | null };
};

function fakeEnv(): EarningsEnv {
  // The current implementation does not touch D1; once the payouts ledger
  // lands, swap this in the test for a real fake-DB harness like
  // account.test.ts uses for cascadeDeleteUser.
  return { DB: {} as unknown as D1Database };
}

function buildApp(asUser: { id: string } | null): Hono<RouteCtx> {
  const app = new Hono<RouteCtx>();
  app.use('*', async (c, next) => {
    if (asUser) {
      c.set('user', { id: asUser.id, email: 'a@b.com', name: 'A' });
    } else {
      c.set('user', null);
    }
    await next();
  });
  app.route('/', earningsRoutes);
  return app;
}

describe('loadPayoutTotals', () => {
  it('returns zero totals across the configured year window', async () => {
    const totals = await loadPayoutTotals(fakeEnv(), 'u1', new Date('2026-05-08T00:00:00Z'));
    expect(totals.lifetimeCents).toBe(0);
    expect(totals.byYear).toHaveLength(EARNINGS_YEAR_WINDOW);
    expect(totals.byYear[0]).toEqual({ year: 2026, cents: 0 });
    expect(totals.byYear[EARNINGS_YEAR_WINDOW - 1]).toEqual({
      year: 2026 - (EARNINGS_YEAR_WINDOW - 1),
      cents: 0,
    });
  });

  it('uses UTC year so the boundary does not flap by reporter timezone', async () => {
    // 2026-01-01T00:30:00Z is 2025-12-31T19:30 in EST. We want UTC year.
    const totals = await loadPayoutTotals(fakeEnv(), 'u1', new Date('2026-01-01T00:30:00Z'));
    expect(totals.byYear[0]?.year).toBe(2026);
  });
});

describe('deriveIssuance', () => {
  it('defaults to self-report until the 1099-K decision is made', () => {
    expect(deriveIssuance()).toEqual({ formIssuance: 'none', notice: 'self-report' });
  });
});

describe('GET /api/account/earnings', () => {
  it('rejects anonymous callers with 401', async () => {
    const app = buildApp(null);
    const res = await app.fetch(
      new Request('http://t/api/account/earnings'),
      fakeEnv() as never,
    );
    expect(res.status).toBe(401);
  });

  it('returns the stable contract for an authed creator', async () => {
    const app = buildApp({ id: 'u1' });
    const res = await app.fetch(
      new Request('http://t/api/account/earnings'),
      fakeEnv() as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lifetimeCents: number;
      byYear: Array<{ year: number; cents: number }>;
      currency: string;
      formIssuance: string;
      notice: string;
    };
    expect(body.currency).toBe('USD');
    expect(body.lifetimeCents).toBe(0);
    expect(body.byYear).toHaveLength(EARNINGS_YEAR_WINDOW);
    expect(body.formIssuance).toBe('none');
    expect(body.notice).toBe('self-report');
  });
});
