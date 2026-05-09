import { useState } from 'react';
import { signIn } from '../lib/auth-client';

// ALO-130: Google + GitHub sign-in buttons. Hits better-auth's
// /api/auth/sign-in/social endpoint; on success the browser is redirected
// to the provider, then back to `callbackURL` once the OAuth dance
// completes. Account linking is handled server-side (auth/index.ts) — a
// returning user with a matching email lands in their existing account.
//
// If a provider has no credentials configured (env vars unset), the button
// still renders; the resulting 400 from the server is surfaced inline so
// the failure mode is obvious in dev / on previews.

const PROVIDERS = [
  { id: 'google' as const, label: 'Continue with Google' },
  { id: 'github' as const, label: 'Continue with GitHub' },
];

export function SocialSignIn({ callbackURL }: { callbackURL: string }): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick(provider: 'google' | 'github'): Promise<void> {
    setError(null);
    setPending(provider);
    try {
      const { error: signInError } = await signIn.social({ provider, callbackURL });
      if (signInError) {
        setPending(null);
        setError(signInError.message ?? `${provider} sign-in failed`);
      }
      // On success the browser navigates to the OAuth provider — no further
      // state to update.
    } catch {
      // Network / client error: reset so the buttons don't stay disabled.
      setPending(null);
      setError(`${provider} sign-in failed`);
    }
  }

  return (
    <div className="stack-sm">
      <div
        className="row"
        style={{ alignItems: 'center', gap: 'var(--space-2)' }}
        aria-hidden
      >
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <span className="ds-meta">or</span>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
      {PROVIDERS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className="btn btn--secondary"
          onClick={() => void onClick(id)}
          disabled={pending !== null}
          aria-label={label}
        >
          {pending === id ? 'Redirecting…' : label}
        </button>
      ))}
      {error ? (
        <p className="status-error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
