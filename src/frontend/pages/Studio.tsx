import { useMemo, type JSX } from 'react';
import { Navigate, useLocation } from '@tanstack/react-router';
import { useSession } from '../lib/auth-client';
import { useSearchParams } from '../lib/use-search-params';
import { StudioRoot } from '../studio';
import { Spinner } from '../create/Spinner';

export function Studio(): JSX.Element {
  const location = useLocation();
  const [sp] = useSearchParams();
  const videoId = sp.get('videoId') ?? undefined;
  const { data: session, isPending } = useSession();
  // Memoize the entire <Navigate> element (not just its search object) so its
  // props identity is stable across re-renders. TanStack's <Navigate> compares
  // previousProps !== props and re-fires on any new props object — a fresh JSX
  // element each render would loop. See RequireAuth in router.tsx.
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
        <h1 className="ds-h2">Verify your email to use the studio</h1>
        <p>The AI Studio is unlocked after you confirm your email.</p>
      </main>
    );
  }
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1 className="ds-h2">AI Studio</h1>
      <p className="ds-lede">Create prompt-generated animations, brainstorm ideas, and generate thumbnails with AI Studio.</p>
      <StudioRoot videoId={videoId} />
    </main>
  );
}
