// ALO-162: public tip surface on /watch/:id. Calls GET /api/videos/:id/tips
// which returns aggregate count + total + the most recent 20 messages of
// paid tips. Refreshes when the URL has ?tip=success so a returning tipper
// sees their message land without a manual refresh.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

type TipMessage = {
  id: string;
  amount_cents: number;
  message: string;
  anonymous: boolean;
  created_at: number;
};

type TipSummary = {
  count: number;
  total_cents: number;
  messages: TipMessage[];
};

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRelative(epochSeconds: number): string {
  const ms = epochSeconds * 1000;
  const delta = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TipsList({ videoId }: { videoId: string }): JSX.Element | null {
  const [data, setData] = useState<TipSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();

  // ?tip=success refetches once after Stripe redirects back so the just-paid
  // tip shows up without a hard reload.
  const tipSignal = params.get('tip');

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/videos/${encodeURIComponent(videoId)}/tips`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Tips fetch failed (${r.status})`);
        return (await r.json()) as TipSummary;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Tips fetch failed');
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, tipSignal]);

  if (error || data === null) return null;
  if (data.count === 0) return null;

  return (
    <section className="stack-sm" aria-label="Tips on this video">
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Tips · {data.count} · {formatDollars(data.total_cents)}
        </h2>
      </div>
      {data.messages.length > 0 ? (
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.messages.map((m) => (
            <li
              key={m.id}
              className="card--tight"
              style={{
                padding: 'var(--space-2) var(--space-3)',
                border: '1px solid color-mix(in oklch, var(--border), transparent 30%)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                <span className="ds-meta">
                  {m.anonymous ? 'Anonymous' : 'Supporter'} · {formatDollars(m.amount_cents)}
                </span>
                <span className="ds-meta">{formatRelative(m.created_at)}</span>
              </div>
              <p style={{ margin: 'var(--space-1) 0 0' }}>{m.message}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
