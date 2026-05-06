import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../lib/auth-client';

export function ForgotPassword(): JSX.Element {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const redirectTo = `${window.location.origin}/reset-password`;
    const result = await requestPasswordReset({ email, redirectTo });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not send reset email');
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <div className="stack-sm" style={{ paddingTop: 'var(--space-8)' }}>
          <span className="ds-label">Check your email</span>
          <h1 className="ds-h2">Reset link sent</h1>
          <p className="ds-lede">
            If an account exists for <strong>{email}</strong>, a password reset link is on its way.
            The link expires in one hour.
          </p>
          <p className="ds-meta">
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Forgot password</span>
        <h1 className="ds-h2">Reset your password</h1>
        <p className="ds-meta">Enter your account email and we'll send a reset link.</p>
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/login" className="ds-meta">Back to sign in</Link>
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
    </main>
  );
}
