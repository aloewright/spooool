import { Hono } from 'hono';

// ALO-163: creator payouts dashboard backend.
//
// Reads from the local `creator_ledger` D1 table for fast renders and,
// when a Polar API token is present, augments the response with the
// authoritative balance + most recent payout from Polar. The dashboard
// degrades gracefully when Polar is unreachable or unconfigured — the
// local ledger is always sufficient to show *something*.

type SessionUser = { id: string; email: string; name: string };

export interface PayoutsEnv {
  DB: D1Database;
  POLAR_API_TOKEN?: string;
  POLAR_API_URL?: string;
}

export interface PayoutsVariables {
  user: SessionUser | null;
}

interface LedgerRow {
  id: string;
  amount_cents: number;
  currency: string;
  kind: string;
  status: string;
  description: string | null;
  external_id: string | null;
  created_at: number;
}

interface TotalsRow {
  earned_cents: number | null;
  pending_cents: number | null;
  available_cents: number | null;
  paid_cents: number | null;
  currency: string | null;
}

export interface PolarSummary {
  balanceCents: number;
  currency: string;
  lastPayoutAt: number | null;
}

export async function fetchPolarSummary(
  env: PayoutsEnv,
  externalAccountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PolarSummary | null> {
  if (!env.POLAR_API_TOKEN) return null;
  const base = env.POLAR_API_URL ?? 'https://api.polar.sh';
  const url = `${base.replace(/\/$/, '')}/v1/accounts/${encodeURIComponent(externalAccountId)}/balance`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${env.POLAR_API_TOKEN}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      balance?: { amount?: number; currency?: string };
      last_payout_at?: string | null;
    };
    if (typeof data.balance?.amount !== 'number') return null;
    return {
      balanceCents: data.balance.amount,
      currency: data.balance.currency ?? 'USD',
      lastPayoutAt: data.last_payout_at ? Date.parse(data.last_payout_at) : null,
    };
  } catch {
    return null;
  }
}

export const payoutsRoutes = new Hono<{
  Bindings: PayoutsEnv;
  Variables: PayoutsVariables;
}>();

payoutsRoutes.get('/api/creator/payouts/summary', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const totals = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN kind != 'payout' AND amount_cents > 0 THEN amount_cents ELSE 0 END), 0) AS earned_cents,
       COALESCE(SUM(CASE WHEN status = 'pending'   THEN amount_cents ELSE 0 END), 0) AS pending_cents,
       COALESCE(SUM(CASE WHEN status = 'available' THEN amount_cents ELSE 0 END), 0) AS available_cents,
       COALESCE(SUM(CASE WHEN status = 'paid'      THEN amount_cents ELSE 0 END), 0) AS paid_cents,
       MAX(currency) AS currency
     FROM creator_ledger WHERE user_id = ?`,
  )
    .bind(user.id)
    .first<TotalsRow>();

  const recent = await c.env.DB.prepare(
    `SELECT id, amount_cents, currency, kind, status, description, external_id, created_at
     FROM creator_ledger WHERE user_id = ?
     ORDER BY created_at DESC LIMIT 25`,
  )
    .bind(user.id)
    .all<LedgerRow>();

  const polar = await fetchPolarSummary(c.env, user.id);

  return c.json({
    currency: totals?.currency ?? polar?.currency ?? 'USD',
    earnedCents: totals?.earned_cents ?? 0,
    pendingCents: totals?.pending_cents ?? 0,
    availableCents: totals?.available_cents ?? 0,
    paidCents: totals?.paid_cents ?? 0,
    polarBalanceCents: polar?.balanceCents ?? null,
    lastPayoutAt: polar?.lastPayoutAt ?? null,
    transactions: recent.results ?? [],
  });
});
