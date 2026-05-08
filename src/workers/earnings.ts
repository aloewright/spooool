// ALO-165: creator-side earnings endpoint.
//
// Returns the signed-in user's payout totals (lifetime + last 5 calendar
// years) so the Account Settings page can render an Earnings & tax forms
// card. Polar is Merchant of Record so buyer-side sales tax / VAT is
// already handled by Polar — the surface here is creator income.
//
// Today there is no `payouts` ledger and no Polar partner-payout webhook,
// so the implementation returns the zero-state shape. The contract is
// stable: when payouts land, swap the `loadPayoutTotals` helper for a
// real D1 query against the new ledger and the frontend can keep its
// existing render path.
//
// See docs/runbooks/creator-tax-reporting.md for the policy and the
// open 1099-K issuance decision.

import { Hono } from 'hono';

export interface EarningsEnv {
  DB: D1Database;
}

type SessionUser = { id: string; email: string; name: string } | null;
type EarningsVariables = { user: SessionUser };

export type EarningsNotice = 'pending-polar' | 'self-report' | 'platform-issued';
export type FormIssuance = 'platform' | 'polar' | 'none';

export interface CreatorEarnings {
  lifetimeCents: number;
  byYear: Array<{ year: number; cents: number }>;
  currency: 'USD';
  formIssuance: FormIssuance;
  notice: EarningsNotice;
}

// Number of recent calendar years to surface, including the current one.
// Matches the IRS retention window most creators care about for matching
// against 1099-K box totals.
export const EARNINGS_YEAR_WINDOW = 5;

// Today: no payouts exist, no `payouts` table. Return zeros for the last
// five years so the UI renders a stable empty state. Once the Polar
// partner webhook lands we'll replace this with a SUM(amount_cents)
// GROUP BY year query against `payouts` filtered to settled rows.
export async function loadPayoutTotals(
  _env: EarningsEnv,
  _userId: string,
  now: Date = new Date(),
): Promise<{ lifetimeCents: number; byYear: Array<{ year: number; cents: number }> }> {
  const currentYear = now.getUTCFullYear();
  const byYear: Array<{ year: number; cents: number }> = [];
  for (let i = 0; i < EARNINGS_YEAR_WINDOW; i += 1) {
    byYear.push({ year: currentYear - i, cents: 0 });
  }
  return { lifetimeCents: 0, byYear };
}

// Until the team decides whether spooool issues 1099-Ks itself or defers
// to Polar's partner program (see docs/creator-tax-reporting.md), default
// to `none` + `self-report`. The frontend translates these to localized
// copy; we keep them as stable keys here so we can flip the decision
// without redeploying the UI.
export function deriveIssuance(): { formIssuance: FormIssuance; notice: EarningsNotice } {
  return { formIssuance: 'none', notice: 'self-report' };
}

export const earningsRoutes = new Hono<{
  Bindings: EarningsEnv;
  Variables: EarningsVariables;
}>();

earningsRoutes.get('/api/account/earnings', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const totals = await loadPayoutTotals(c.env, user.id);
  const issuance = deriveIssuance();
  const body: CreatorEarnings = {
    lifetimeCents: totals.lifetimeCents,
    byYear: totals.byYear,
    currency: 'USD',
    ...issuance,
  };
  return c.json(body);
});
