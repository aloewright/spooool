import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

export function Waitlist(): JSX.Element {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Something went wrong. Try again.');
        return;
      }
      setDone(true);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
          <span className="ds-label">Waitlist</span>
          <h1 className="ds-h2">You're on the list</h1>
        </div>
        <p className="ds-lede">
          We'll email {email} when your invite is ready. No action needed.
        </p>
        <Link to="/" className="ds-meta">
          Back to home
        </Link>
      </main>
    );
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Beta access</span>
        <h1 className="ds-h2">Join the waitlist</h1>
        <p className="ds-lede" style={{ maxWidth: 460 }}>
          Spooool is in private beta. Drop your email and we'll send an invite
          when a spot opens up.
        </p>
      </div>

      <form onSubmit={(e) => void onSubmit(e)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="waitlist-email">Email address</label>
          <input
            id="waitlist-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
          />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/login" className="ds-meta">
            Already have an invite? Sign up
          </Link>
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Joining…' : 'Join waitlist'}
          </button>
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
    </main>
  );
}
