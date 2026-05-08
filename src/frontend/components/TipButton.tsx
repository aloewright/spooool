// ALO-162: per-video tipping UI. Opens an inline form, POSTs to
// /api/videos/:id/tips/checkout, and redirects to the Stripe-hosted
// Checkout page. Anonymous tipping is supported (auth optional). On
// return, /watch/:id?tip=success surfaces a thank-you toast (handled
// inline below).

import { useEffect, useState } from 'react';

const PRESET_AMOUNTS_CENTS = [200, 500, 1000, 2000];
const MAX_MESSAGE_LENGTH = 280;

interface TipButtonProps {
  videoId: string;
}

export function TipButton({ videoId }: TipButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [amountCents, setAmountCents] = useState<number>(500);
  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanked, setThanked] = useState(false);

  // Surface ?tip=success once after Stripe redirects back. We don't strip
  // the param — turbo-style nav will replace it on next click anyway.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('tip') === 'success') setThanked(true);
  }, []);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/tips/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_cents: amountCents,
          message: message.trim() || undefined,
          anonymous,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? `Tip failed (${res.status})`);
      }
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tip failed');
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--secondary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        ❤ Tip
      </button>
      {thanked ? (
        <span className="ds-meta" role="status">
          Thanks for the tip!
        </span>
      ) : null}
      {open ? (
        <form
          onSubmit={handleSubmit}
          className="stack-sm"
          style={{ width: '100%', marginTop: 'var(--space-2)' }}
        >
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-1)' }}>
            {PRESET_AMOUNTS_CENTS.map((c) => (
              <button
                key={c}
                type="button"
                className={amountCents === c ? 'btn btn--sm' : 'btn btn--ghost btn--sm'}
                onClick={() => setAmountCents(c)}
                aria-pressed={amountCents === c}
              >
                ${(c / 100).toFixed(0)}
              </button>
            ))}
            <label className="ds-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Custom $
              <input
                type="number"
                min={1}
                max={500}
                step={1}
                value={(amountCents / 100).toString()}
                onChange={(e) => {
                  const dollars = Number.parseFloat(e.target.value);
                  if (Number.isFinite(dollars) && dollars > 0) {
                    const clamped = Math.min(500, Math.max(1, dollars));
                    setAmountCents(Math.round(clamped * 100));
                  }
                }}
                style={{ width: 80 }}
                aria-label="Custom tip amount in dollars"
              />
            </label>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            placeholder="Add a message (optional)"
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            aria-label="Optional tip message"
          />
          <label className="ds-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            Tip anonymously
          </label>
          {error ? <p className="status-error">{error}</p> : null}
          <div className="row" style={{ gap: 'var(--space-1)' }}>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Redirecting…' : `Send $${(amountCents / 100).toFixed(2)}`}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}
