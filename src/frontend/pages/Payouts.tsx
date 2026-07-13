import { useEffect, useState } from 'react';
import { useSession } from '../lib/auth-client';

interface PayoutSummary {
  total_earned_cents: number;
  fees_cents: number;
  net_earned_cents: number;
  paid_out_cents: number;
  pending_payout_cents: number;
  polar_live: boolean;
  currency: string;
}

interface EarningsTransaction {
  id: string;
  kind: 'tip' | 'membership' | 'gift';
  amount_cents: number;
  platform_fee_cents: number;
  currency: string;
  description: string | null;
  // D1 returns ms-epoch integers (stored as TEXT in SQLite) as strings like "1700000000000"
  created_at: string | number;
}

interface LocalPayout {
  id: string;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'in_transit' | 'paid' | 'failed';
  polar_payout_id: string | null;
  paid_at: string | number | null;
  // D1 returns ms-epoch integers (stored as TEXT in SQLite) as strings like "1700000000000"
  created_at: string | number;
}

interface PolarPayoutItem {
  id: string;
  type: string;
  amount: number;
  currency: string;
  created_at: string;
}

function fmtMoney(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// created_at may arrive as a numeric ms-epoch string ("1700000000000") or ISO string.
function fmtDate(val: string | number): string {
  const n = typeof val === 'number' ? val : Number(val);
  const d = Number.isFinite(n) ? new Date(n) : new Date(val as string);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const KIND_LABEL: Record<string, string> = {
  tip: 'Tip',
  membership: 'Membership',
  gift: 'Gift',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_transit: 'In transit',
  paid: 'Paid',
  failed: 'Failed',
};

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): JSX.Element {
  return (
    <div
      className="card"
      style={{ padding: 'var(--space-4)', minWidth: 0 }}
    >
      <p className="ds-meta" style={{ marginBottom: 'var(--space-1)' }}>
        {label}
      </p>
      <p
        style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 700,
          letterSpacing: '-0.015em',
          margin: 0,
        }}
      >
        {value}
      </p>
      {sub && (
        <p className="ds-meta" style={{ marginTop: 'var(--space-1)' }}>
          {sub}
        </p>
      )}
    </div>
  );
}

export function Payouts(): JSX.Element {
  const { data: session, isPending } = useSession();

  const [summary, setSummary] = useState<PayoutSummary | null>(null);
  const [transactions, setTransactions] = useState<EarningsTransaction[] | null>(null);
  const [localPayouts, setLocalPayouts] = useState<LocalPayout[] | null>(null);
  const [polarPayouts, setPolarPayouts] = useState<PolarPayoutItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const [sumRes, txnRes, histRes] = await Promise.all([
          fetch('/api/payouts/summary', { credentials: 'include' }),
          fetch('/api/payouts/transactions?limit=20', { credentials: 'include' }),
          fetch('/api/payouts/history?limit=10', { credentials: 'include' }),
        ]);
        if (!sumRes.ok || !txnRes.ok || !histRes.ok) {
          throw new Error('Failed to load payout data');
        }
        const [sumData, txnData, histData] = await Promise.all([
          sumRes.json() as Promise<PayoutSummary>,
          txnRes.json() as Promise<{ transactions: EarningsTransaction[] }>,
          histRes.json() as Promise<{ payouts: LocalPayout[]; polar_payouts: PolarPayoutItem[] }>,
        ]);
        if (cancelled) return;
        setSummary(sumData);
        setTransactions(txnData.transactions);
        setLocalPayouts(histData.payouts);
        setPolarPayouts(histData.polar_payouts);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-meta">Loading…</p>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Sign in required.</p>
      </main>
    );
  }

  const currency = summary?.currency ?? 'usd';

  // Merge local + Polar payouts into a single sorted list, deduping by polar_payout_id.
  const seenPolarIds = new Set<string>(
    (localPayouts ?? [])
      .map((p) => p.polar_payout_id)
      .filter((id): id is string => id !== null),
  );
  const mergedPayouts: Array<
    { source: 'local'; item: LocalPayout } | { source: 'polar'; item: PolarPayoutItem }
  > = [
    ...(localPayouts ?? []).map((item) => ({ source: 'local' as const, item })),
    ...polarPayouts
      .filter((p) => !seenPolarIds.has(p.id))
      .map((item) => ({ source: 'polar' as const, item })),
  ].sort((a, b) => {
    const aDate = a.source === 'local' ? a.item.created_at : a.item.created_at;
    const bDate = b.source === 'local' ? b.item.created_at : b.item.created_at;
    return bDate.localeCompare(aDate);
  });

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">Payouts</h1>
        <p className="ds-lede">Your earnings, pending payouts, and payout history.</p>
        {summary?.polar_live && (
          <p className="ds-meta">Pending balance is live from Polar.</p>
        )}
      </header>

      {error && <p className="status-error">{error}</p>}

      {/* Summary cards */}
      {summary === null && !error ? (
        <p className="ds-empty">Loading summary…</p>
      ) : summary !== null ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <StatCard
            label="Total earned (gross)"
            value={fmtMoney(summary.total_earned_cents, currency)}
          />
          <StatCard
            label="Platform fees (10%)"
            value={fmtMoney(summary.fees_cents, currency)}
          />
          <StatCard
            label="Net earnings"
            value={fmtMoney(summary.net_earned_cents, currency)}
            sub="after platform fee"
          />
          <StatCard
            label="Pending payout"
            value={fmtMoney(summary.pending_payout_cents, currency)}
            sub={summary.polar_live ? 'live balance' : 'from ledger'}
          />
          <StatCard
            label="Total paid out"
            value={fmtMoney(summary.paid_out_cents, currency)}
          />
        </div>
      ) : null}

      {/* Recent transactions */}
      <section className="stack-sm" aria-label="Recent transactions">
        <h2 className="ds-h3" style={{ margin: 0 }}>Recent transactions</h2>
        {transactions === null && !error ? (
          <p className="ds-empty">Loading…</p>
        ) : transactions !== null && transactions.length === 0 ? (
          <p className="ds-empty">No earnings yet. Enable tipping or memberships to get started.</p>
        ) : transactions !== null ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="info-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="num">Gross</th>
                  <th className="num">Fee</th>
                  <th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id}>
                    <td className="ds-meta">{fmtDate(tx.created_at)}</td>
                    <td>{KIND_LABEL[tx.kind] ?? tx.kind}</td>
                    <td className="ds-meta">{tx.description ?? '—'}</td>
                    <td className="num">{fmtMoney(tx.amount_cents, tx.currency)}</td>
                    <td className="num ds-meta">
                      {tx.platform_fee_cents > 0
                        ? fmtMoney(tx.platform_fee_cents, tx.currency)
                        : '—'}
                    </td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {fmtMoney(tx.amount_cents - tx.platform_fee_cents, tx.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {/* Payout history */}
      <section className="stack-sm" aria-label="Payout history">
        <h2 className="ds-h3" style={{ margin: 0 }}>Payout history</h2>
        {localPayouts === null && !error ? (
          <p className="ds-empty">Loading…</p>
        ) : mergedPayouts.length === 0 ? (
          <p className="ds-empty">No payouts recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="info-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {mergedPayouts.map((row) => {
                  if (row.source === 'local') {
                    const p = row.item;
                    return (
                      <tr key={`local-${p.id}`}>
                        <td className="ds-meta">
                          {fmtDate(p.paid_at ?? p.created_at)}
                        </td>
                        <td className="num" style={{ fontWeight: 600 }}>
                          {fmtMoney(p.amount_cents, p.currency)}
                        </td>
                        <td>
                          <span
                            style={{
                              color:
                                p.status === 'paid'
                                  ? 'var(--success, green)'
                                  : p.status === 'failed'
                                  ? 'var(--destructive)'
                                  : undefined,
                            }}
                          >
                            {STATUS_LABEL[p.status] ?? p.status}
                          </span>
                        </td>
                        <td className="ds-meta">Ledger</td>
                      </tr>
                    );
                  }
                  const p = row.item;
                  return (
                    <tr key={`polar-${p.id}`}>
                      <td className="ds-meta">{fmtDate(p.created_at)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {fmtMoney(p.amount, p.currency)}
                      </td>
                      <td>Paid</td>
                      <td className="ds-meta">Polar</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
