import { useEffect, useState } from 'react';

interface Transaction {
  id: string;
  amount_cents: number;
  currency: string;
  kind: string;
  status: string;
  description: string | null;
  external_id: string | null;
  created_at: number;
}

interface PayoutsSummary {
  currency: string;
  earnedCents: number;
  pendingCents: number;
  availableCents: number;
  paidCents: number;
  polarBalanceCents: number | null;
  lastPayoutAt: number | null;
  transactions: Transaction[];
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="suggestion-card" style={{ padding: 'var(--space-4)' }}>
      <div className="ds-meta" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 'var(--text-xl)' }}>{value}</div>
      {sub ? <div className="ds-meta" style={{ marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

export function CreatorPayouts(): JSX.Element {
  const [summary, setSummary] = useState<PayoutsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/creator/payouts/summary', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load payouts');
        return (await r.json()) as PayoutsSummary;
      })
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="app-main app-main--narrow stack">
        <h1 className="ds-h2">Creator payouts</h1>
        <p className="status-error">{error}</p>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className="app-main app-main--narrow stack">
        <h1 className="ds-h2">Creator payouts</h1>
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  const { currency, earnedCents, pendingCents, availableCents, paidCents, polarBalanceCents, lastPayoutAt, transactions } =
    summary;

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h2" style={{ margin: 0 }}>Creator payouts</h1>
        <p className="ds-meta" style={{ margin: 0 }}>
          Earnings, pending balance, and recent transactions. Payouts are processed via Polar.
        </p>
      </header>

      <section
        aria-label="Balance summary"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        <StatCard
          label="Lifetime earned"
          value={formatMoney(earnedCents, currency)}
          sub={paidCents > 0 ? `${formatMoney(paidCents, currency)} paid out` : undefined}
        />
        <StatCard
          label="Available"
          value={formatMoney(availableCents, currency)}
          sub="Ready to be paid out"
        />
        <StatCard
          label="Pending"
          value={formatMoney(pendingCents, currency)}
          sub="Clearing through processor"
        />
        <StatCard
          label="Polar balance"
          value={polarBalanceCents === null ? '—' : formatMoney(polarBalanceCents, currency)}
          sub={lastPayoutAt ? `Last payout ${formatDate(lastPayoutAt)}` : 'No payouts yet'}
        />
      </section>

      <section className="stack-sm" aria-label="Recent transactions">
        <h2 className="ds-h3" style={{ margin: 0 }}>Recent transactions</h2>
        {transactions.length === 0 ? (
          <p className="ds-empty">No transactions yet — earnings will appear here once your first tip or subscription clears.</p>
        ) : (
          <div role="table" style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <div
              role="row"
              className="ds-meta"
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 1fr 110px 110px',
                gap: 'var(--space-3)',
                paddingBottom: 'var(--space-1)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span role="columnheader">Date</span>
              <span role="columnheader">Description</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" style={{ textAlign: 'right' }}>Amount</span>
            </div>
            {transactions.map((tx) => (
              <div
                key={tx.id}
                role="row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 1fr 110px 110px',
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                }}
              >
                <span role="cell" className="ds-meta">{formatDate(tx.created_at)}</span>
                <span role="cell">
                  <strong style={{ textTransform: 'capitalize' }}>{tx.kind.replace(/_/g, ' ')}</strong>
                  {tx.description ? <span className="ds-meta"> — {tx.description}</span> : null}
                </span>
                <span role="cell" className="ds-meta" style={{ textTransform: 'capitalize' }}>{tx.status}</span>
                <span
                  role="cell"
                  style={{
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: tx.amount_cents < 0 ? 'var(--text-muted)' : undefined,
                  }}
                >
                  {formatMoney(tx.amount_cents, tx.currency)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
