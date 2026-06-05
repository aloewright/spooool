import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { resetPassword } from '../lib/auth-client';
import { TurnstileWidget } from '../components/TurnstileWidget';

export function ResetPassword(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <main className="app-main app-main--narrow stack-lg">
        <h1 className="ds-h2">Invalid reset link</h1>
        <p className="ds-lede">This link is missing a token. Request a new one to continue.</p>
        <p className="ds-meta">
          <Link to="/forgot-password">Request a new reset link</Link>
        </p>
      </main>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    if (!captchaToken) {
      setError('Please complete the captcha');
      return;
    }

    setSubmitting(true);
    const result = await resetPassword({ token, newPassword: password, captchaToken });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not reset password');
      return;
    }
    navigate('/login', {
      replace: true,
      state: { from: '/' },
    });
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Reset password</span>
        <h1 className="ds-h2">Choose a new password</h1>
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="reset-password">New password</label>
          <input
            id="reset-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            required
          />
          <span className="ds-meta">8 characters minimum.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="reset-confirm">Confirm password</label>
          <input
            id="reset-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            minLength={8}
            required
          />
        </div>

        <TurnstileWidget onSuccess={(token) => setCaptchaToken(token)} />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/login" className="ds-meta">Back to sign in</Link>
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Saving…' : 'Set new password'}
          </button>
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
    </main>
  );
}
