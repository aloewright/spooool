// ALO-127 — public waitlist landing for the E8 launch. Posts to
// /api/waitlist (rate-limited per-IP, INSERT-OR-IGNORE in D1, best-effort
// Resend audience sync). The page is intentionally pre-auth — no session
// required.

import { FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

interface SubmitState {
  status: 'idle' | 'submitting' | 'success' | 'error';
  message?: string;
}

export function Waitlist(): JSX.Element {
  const [params] = useSearchParams();
  const tier = params.get('tier') ?? null;
  const [email, setEmail] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/waitlist/count')
      .then(async (r) => (r.ok ? ((await r.json()) as { count: number }) : null))
      .then((data) => {
        if (!cancelled && data) setCount(data.count);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmit({ status: 'submitting' });
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          source: tier ? `pricing:${tier}` : 'waitlist',
          referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
        }),
      });
      if (res.status === 201) {
        setSubmit({ status: 'success' });
        setEmail('');
        // Optimistically bump the public counter so the success state feels
        // alive without a second round-trip.
        setCount((c) => (c === null ? c : c + 1));
        void import('../lib/analytics').then(({ track }) => {
          track('waitlist_signup', { source: tier ? `pricing:${tier}` : 'waitlist' });
        });
        return;
      }
      if (res.status === 429) {
        setSubmit({
          status: 'error',
          message: 'Too many signups from your network. Try again in a few minutes.',
        });
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setSubmit({
        status: 'error',
        message: body?.error ?? 'Something went wrong. Please try again.',
      });
    } catch (err) {
      setSubmit({
        status: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      });
    }
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingTop: 'var(--space-8)' }}
      >
        <span className="ds-label">Beta waitlist</span>
        <h1 className="ds-h1" style={{ margin: 0 }}>Get early access to spooool.</h1>
        <p className="ds-lede" style={{ maxWidth: 480, margin: '0 auto' }}>
          We&apos;re onboarding the first 100 creators in waves. Drop your email and
          we&apos;ll send your invite as soon as a slot opens.
        </p>
        {count !== null ? (
          <p className="ds-meta">{count.toLocaleString()} people on the list so far.</p>
        ) : null}
      </section>

      <form onSubmit={(e) => void onSubmit(e)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="waitlist-email">Email</label>
          <input
            id="waitlist-email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submit.status === 'submitting' || submit.status === 'success'}
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/" className="ds-meta">Back home</Link>
          <button
            type="submit"
            className="btn"
            disabled={submit.status === 'submitting' || submit.status === 'success'}
          >
            {submit.status === 'submitting' ? 'Joining…' : submit.status === 'success' ? 'You’re on the list' : 'Join the waitlist'}
          </button>
        </div>
      </form>

      {submit.status === 'success' ? (
        <p className="status-ok">
          Thanks — we&apos;ll email you the moment your invite is ready. In the meantime,
          you can <Link to="/help">read the help center</Link> or skim the{' '}
          <Link to="/pricing">pricing page</Link>.
        </p>
      ) : null}
      {submit.status === 'error' && submit.message ? (
        <p className="status-error">{submit.message}</p>
      ) : null}
    </main>
  );
}
