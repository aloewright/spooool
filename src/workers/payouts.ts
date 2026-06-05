// ALO-XXX: creator payout dashboard API.
//
// Three endpoints for the /payouts page:
//   GET /api/payouts/summary     — earnings totals from D1 + live Polar balance
//   GET /api/payouts/transactions — recent earnings events from D1
//   GET /api/payouts/history      — payout disbursement history (D1 + Polar)
//
// Polar API calls are best-effort: if POLAR_ACCESS_TOKEN is absent or the
// creator has no polar_account_id linked, the response degrades gracefully to
// D1-only data. The Polar endpoint is v1/transactions/search and
// v1/transactions/sum — both require an account_id query parameter.

import { Hono } from 'hono';
import { z } from 'zod';

export interface PayoutsEnv {
  DB: D1Database;
  POLAR_ACCESS_TOKEN?: string;
}

type SessionUser = { id: string } | null;
type PayoutsVariables = { user: SessionUser };

const POLAR_BASE = 'https://api.polar.sh';

async function polarGet<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  try {
    const url = new URL(`${POLAR_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface PolarTransactionItem {
  id: string;
  type: string;
  amount: number;
  currency: string;
  created_at: string;
}

interface PolarTransactionsPage {
  items: PolarTransactionItem[];
  pagination: { total_count: number; max_page: number };
}

interface PolarTransactionSum {
  balance: { amount: number; currency: string };
  payout_amount: { amount: number; currency: string };
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const payoutsRoutes = new Hono<{
  Bindings: PayoutsEnv;
  Variables: PayoutsVariables;
}>();

async function creatorPolarAccountId(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT polar_account_id FROM user WHERE id = ?')
    .bind(userId)
    .first<{ polar_account_id: string | null }>();
  return row?.polar_account_id ?? null;
}

payoutsRoutes.get('/api/payouts/summary', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [earningsRow, paidRow, pendingRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total,
              COALESCE(SUM(platform_fee_cents), 0) AS fees
       FROM creator_earnings WHERE user_id = ?`,
    )
      .bind(user.id)
      .first<{ total: number; fees: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM creator_payouts WHERE user_id = ? AND status = 'paid'`,
    )
      .bind(user.id)
      .first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM creator_payouts WHERE user_id = ? AND status IN ('pending', 'in_transit')`,
    )
      .bind(user.id)
      .first<{ total: number }>(),
  ]);

  const totalEarned = Number(earningsRow?.total ?? 0);
  const fees = Number(earningsRow?.fees ?? 0);
  const paidOut = Number(paidRow?.total ?? 0);
  const pendingLocal = Number(pendingRow?.total ?? 0);

  let polarPendingCents: number | null = null;
  let polarCurrency: string | null = null;

  if (c.env.POLAR_ACCESS_TOKEN) {
    const accountId = await creatorPolarAccountId(c.env.DB, user.id);
    if (accountId) {
      const sum = await polarGet<PolarTransactionSum>(
        c.env.POLAR_ACCESS_TOKEN,
        '/v1/transactions/sum',
        { account_id: accountId },
      );
      if (sum) {
        polarPendingCents = sum.balance.amount;
        polarCurrency = sum.balance.currency;
      }
    }
  }

  return c.json({
    total_earned_cents: totalEarned,
    fees_cents: fees,
    net_earned_cents: totalEarned - fees,
    paid_out_cents: paidOut,
    // Prefer live Polar balance; fall back to D1 pending sum.
    pending_payout_cents: polarPendingCents ?? pendingLocal,
    polar_live: polarPendingCents !== null,
    currency: polarCurrency ?? 'usd',
  });
});

payoutsRoutes.get('/api/payouts/transactions', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, amount_cents, platform_fee_cents, currency, description, created_at
     FROM creator_earnings
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(user.id, limit)
    .all();

  return c.json({ transactions: results });
});

payoutsRoutes.get('/api/payouts/history', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  const [{ results: localPayouts }, accountId] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, amount_cents, currency, status, polar_payout_id, paid_at, created_at
       FROM creator_payouts
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(user.id, limit)
      .all(),
    c.env.POLAR_ACCESS_TOKEN
      ? creatorPolarAccountId(c.env.DB, user.id)
      : Promise.resolve(null),
  ]);

  let polarPayouts: PolarTransactionItem[] = [];
  if (c.env.POLAR_ACCESS_TOKEN && accountId) {
    const page = await polarGet<PolarTransactionsPage>(
      c.env.POLAR_ACCESS_TOKEN,
      '/v1/transactions/search',
      { account_id: accountId, type: 'payout', limit: String(limit) },
    );
    if (page) polarPayouts = page.items;
  }

  return c.json({ payouts: localPayouts, polar_payouts: polarPayouts });
});
