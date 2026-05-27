import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { CreateRoot } from '../create';
import { Spinner } from '../create/Spinner';

export function Create(): JSX.Element {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const debug = searchParams.get('debug') === '1';
  const { data: session, isPending } = useSession();
  if (isPending) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in" style={{ padding: 24 }}>
        <Spinner label="Loading session…" />
      </main>
    );
  }
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
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
