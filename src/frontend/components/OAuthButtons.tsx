import { useState } from 'react';
import { signIn } from '../lib/auth-client';

// ALO-120: OAuth sign-in buttons rendered on Login + Signup. Better-auth's
// social sign-in handles the redirect dance; we just hand it a provider id
// and a callbackURL. If the provider isn't configured server-side, the
// request will return an error which we surface inline.
interface Props {
  callbackURL?: string;
}

export function OAuthButtons({ callbackURL = '/' }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(provider: 'google' | 'github'): Promise<void> {
    setError(null);
    setBusy(provider);
    try {
      const { error: err } = await signIn.social({ provider, callbackURL });
      if (err) setError(err.message ?? `${provider} sign-in failed`);
    } catch (e) {
      setError(e instanceof Error ? e.message : `${provider} sign-in failed`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack-sm" aria-label="Sign in with a social provider">
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void handle('google')}
          disabled={busy !== null}
        >
          {busy === 'google' ? 'Connecting…' : 'Continue with Google'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void handle('github')}
          disabled={busy !== null}
        >
          {busy === 'github' ? 'Connecting…' : 'Continue with GitHub'}
        </button>
      </div>
      {error ? <p className="status-error">{error}</p> : null}
    </div>
  );
}
