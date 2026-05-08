// ALO-162: creator-side onboarding for per-video tipping. Renders one of
// three states based on /api/tips/connect/status:
//   - not connected → "Set up tipping" button
//   - onboarding pending (charges_enabled=false) → "Resume Stripe onboarding"
//   - charges_enabled=true → "You're set up to receive tips"
// Calling onboard always returns a fresh AccountLink URL (single-use), so
// we redirect on click rather than caching the URL.
import { useEffect, useState } from 'react';

type Status = {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted?: boolean;
};

export function PayoutsCard(): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/tips/connect/status', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Status fetch failed (${r.status})`);
        return (await r.json()) as Status;
      })
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startOnboarding = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tips/connect/onboard', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Onboarding failed (${res.status})`);
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error('Stripe did not return an onboarding URL');
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Onboarding failed');
      setBusy(false);
    }
  };

  return (
    <section className="stack-sm" aria-label="Tipping payouts">
      <span className="ds-label">Tipping payouts</span>
      {loading ? (
        <p className="ds-meta">Loading…</p>
      ) : status?.charges_enabled ? (
        <>
          <p className="ds-meta">
            Connected to Stripe. Tips are routed via Stripe Connect; spooool retains a 10% platform fee.
          </p>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void startOnboarding()}>
            {busy ? 'Redirecting…' : 'Update Stripe details'}
          </button>
        </>
      ) : status?.connected ? (
        <>
          <p className="ds-meta">
            Stripe onboarding started but not yet finished. Resume it to start receiving tips.
          </p>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void startOnboarding()}>
            {busy ? 'Redirecting…' : 'Resume Stripe onboarding'}
          </button>
        </>
      ) : (
        <>
          <p className="ds-meta">
            Accept one-off tips on your videos via Stripe Connect Express. spooool retains a 10% platform fee.
          </p>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void startOnboarding()}>
            {busy ? 'Redirecting…' : 'Set up tipping'}
          </button>
        </>
      )}
      {error ? <p className="status-error">{error}</p> : null}
    </section>
  );
}
