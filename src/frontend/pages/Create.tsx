import { useMemo, type JSX } from 'react';
import { Navigate, useLocation } from '@tanstack/react-router';
import { useSession } from '../lib/auth-client';
import { useSearchParams } from '../lib/use-search-params';
import { CreateRoot } from '../create';
import { Spinner } from '../create/Spinner';

export function Create(): JSX.Element {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const debug = searchParams.get('debug') === '1';
  const { data: session, isPending } = useSession();
  // Memoize the whole <Navigate> element so its props identity is stable —
  // TanStack's <Navigate> re-fires on any new props object (loop). See
  // RequireAuth in router.tsx.
  const loginRedirect = useMemo(
    () => <Navigate to="/login" search={{ from: location.pathname }} replace />,
    [location.pathname],
  );
  if (isPending) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in" style={{ padding: 24 }}>
        <Spinner label="Loading session…" />
      </main>
    );
  }
  if (!session) return loginRedirect;
  if (session.user.emailVerified === false) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Verify your email to create videos</h1>
        <p>Generation is unlocked after you confirm your email.</p>
      </main>
    );
  }
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1 className="ds-h2">Create a video from a prompt</h1>
      <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)', marginTop: -8 }}>
        Toggle the debug panel by appending <code>?debug=1</code> to the URL.
      </p>
      <CreateRoot debug={debug} />
    </main>
  );
}
