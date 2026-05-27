import { useSession } from '../lib/auth-client';
import { RecorderRoot } from '../recorder';

export function Record(): JSX.Element {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-meta">Loading…</p>
      </main>
    );
  }

  // RequireAuth handles the unauthenticated redirect, but guard defensively
  // in case this page is ever rendered outside that wrapper.
  if (!session) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Sign in to record</h1>
        <p>You need to be signed in to use the recorder.</p>
      </main>
    );
  }

  // emailVerified is absent (undefined) on legacy accounts — treat absence as
  // verified, matching the Upload page convention.
  const isEmailVerified = session.user.emailVerified !== false;
  if (!isEmailVerified) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Verify your email to record</h1>
        <p>
          Recording is unlocked after you confirm your email address. Check
          your inbox for the verification email.
        </p>
      </main>
    );
  }

  if (typeof window !== 'undefined' && !('VideoEncoder' in window)) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Browser not supported</h1>
        <p>
          The recorder needs WebCodecs (Chrome, Edge, or Firefox 130+). Please
          switch browsers, or use the{' '}
          <a href="/upload">upload page</a> instead.
        </p>
      </main>
    );
  }

  return <RecorderRoot />;
}
