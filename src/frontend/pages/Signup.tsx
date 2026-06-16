import { FormEvent, useState, type JSX } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { signUp, useSession } from '../lib/auth-client';
import { TurnstileWidget } from '../components/TurnstileWidget';
import { SocialAuthButtons } from '../components/SocialAuthButtons';

export function Signup(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [name, setName] = useState('');
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
    const { data, error: signUpError } = await signUp.email(
      { email, password, name },
      captchaToken ? { headers: { 'x-captcha-response': captchaToken } } : undefined,
    );
    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message ?? 'Sign up failed');
      return;
    }
    // Best-effort welcome-email trigger. Fire-and-forget — a missing
    // EMAIL binding, an unverified domain, or a transient send failure
    // must never block the post-signup navigation. The endpoint is a
    // no-op when isNewSignup is false.
    void fetch('/api/lifecycle/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isNewSignup: true }),
      keepalive: true,
    }).catch(() => undefined);
    // ALO-166 / observability: stamp the visitor with their user id so
    // PostHog stitches pre-signup activity to the new account, then emit
    // the signup event for funnel analytics.
    const newUserId = data?.user?.id;
    if (newUserId) {
      void import('../lib/analytics').then(({ identify, track }) => {
        identify(newUserId, { signup_source: 'email_password' });
        track('signup_completed', { method: 'email_password' });
      });
    }
    // ALO-178: send new accounts through the 3-step onboarding unless they
    // hit signup with an explicit redirect target (deep-link / post-login).
    const target = next === '/' ? '/onboarding' : next;
    navigate(target, { replace: true });
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Create account</span>
        <h1 className="ds-h2">Sign up</h1>
      </div>

      <SocialAuthButtons callbackURL={next === '/' ? '/onboarding' : next} onError={setError} />

      <form onSubmit={(event) => void onSubmit(event)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="signup-name">Name</label>
          <input
            id="signup-name"
            className="input"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
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

        <TurnstileWidget onSuccess={(token) => setCaptchaToken(token)} />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/login" state={{ from: next }} className="ds-meta">
            Already have an account? Sign in
          </Link>
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
    </main>
  );
}
