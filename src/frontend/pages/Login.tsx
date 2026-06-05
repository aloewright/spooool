import { FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { signIn, useSession } from '../lib/auth-client';
import { TurnstileWidget } from '../components/TurnstileWidget';

export function Login(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = (location.state as { from?: string } | null)?.from ?? '/';

  if (!isPending && session) {
    return <Navigate to={next} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (import.meta.env.VITE_TURNSTILE_SITE_KEY && !captchaToken) {
      setError('Please complete the captcha');
      return;
    }

    setError(null);
    setSubmitting(true);
    const { data, error: signInError } = await signIn.email(
      { email, password },
      {
        headers: {
          'x-captcha-response': captchaToken,
        },
      }
    );
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? 'Sign in failed');
      return;
    }
    // ALO-166 / observability: re-identify the visitor so PostHog rejoins
    // sessions across devices / cookie clears.
    const userId = data?.user?.id;
    if (userId) {
      // .catch silences chunk-load failures so a transient asset error can't
      // surface as an unhandled rejection on the login completion path.
      void import('../lib/analytics')
        .then(({ identify, track }) => {
          identify(userId);
          // ALO-184: separate from signup_completed so we can chart returning
          // vs new-user funnels. No email or password ever leaves the browser.
          track('login_completed', { method: 'email_password' });
        })
        .catch(() => undefined);
    }
    navigate(next, { replace: true });
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Welcome back</span>
        <h1 className="ds-h2">Sign in</h1>
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="login-email">Email</label>
          <input
            id="login-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <TurnstileWidget onSuccess={(token) => setCaptchaToken(token)} />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/signup" state={{ from: next }} className="ds-meta">
            Need an account? Sign up
          </Link>
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Link to="/forgot-password" className="ds-meta">Forgot your password?</Link>
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
    </main>
  );
}
