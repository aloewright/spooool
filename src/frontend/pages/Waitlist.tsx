import { FormEvent, useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';

export function Waitlist(): JSX.Element {
  const [email, setEmail] = useState('');
  const [name, setName]   = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setState('submitting');
    setErrorMsg('');

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || undefined, source: 'waitlist-page' }),
      });
      if (!res.ok && res.status !== 201) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setState('done');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong — try again.');
      setState('error');
    }
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in" style={{ paddingTop: 'var(--space-10)' }}>
      <section className="stack-sm" style={{ textAlign: 'center' }}>
        <span className="ds-label">Early access</span>
        <h1 className="ds-h2">Join the waitlist</h1>
        <p className="ds-lede" style={{ maxWidth: 480, margin: '0 auto' }}>
          spooool is opening up to creators. Drop your email and we'll let you know
          when your spot is ready — no spam, one email.
        </p>
      </section>

      {state === 'done' ? (
        <section className="card stack-sm" style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
          <div style={{ fontSize: 'var(--text-2xl)' }}>🎉</div>
          <h2 className="ds-h3">You're on the list</h2>
          <p className="ds-meta">
            We'll email you at <strong>{email}</strong> when your spot is ready.
          </p>
          <p className="ds-meta">
            Can't wait?{' '}
            <Link to="/signup" className="ds-link">
              Sign up now
            </Link>{' '}
            — the platform is open.
          </p>
        </section>
      ) : (
        <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
          <div className="stack-sm">
            <label htmlFor="wl-name" className="ds-label">
              Name <span className="ds-meta">(optional)</span>
            </label>
            <input
              id="wl-name"
              type="text"
              className="input"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoComplete="name"
            />
          </div>

          <div className="stack-sm">
            <label htmlFor="wl-email" className="ds-label">
              Email
            </label>
            <input
              id="wl-email"
              type="email"
              className="input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
              autoComplete="email"
            />
          </div>

          {state === 'error' && (
            <p role="alert" className="status-error">
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            className="btn"
            disabled={state === 'submitting'}
          >
            {state === 'submitting' ? 'Joining…' : 'Join the waitlist'}
          </button>

          <p className="ds-meta" style={{ textAlign: 'center' }}>
            Already ready to go?{' '}
            <Link to="/signup" className="ds-link">
              Create an account
            </Link>
          </p>
        </form>
      )}

      <section className="stack-sm" style={{ textAlign: 'center' }}>
        <p className="ds-meta">
          <Link to="/pricing">See what's included in each plan →</Link>
        </p>
      </section>
    </main>
  );
}
