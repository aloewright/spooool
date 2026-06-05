import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { StudioRoot } from '../studio';
import { Spinner } from '../create/Spinner';

export function Studio(): JSX.Element {
  const location = useLocation();
  const [sp] = useSearchParams();
  const videoId = sp.get('videoId') ?? undefined;
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
        <h1 className="ds-h2">Verify your email to use the studio</h1>
        <p>The AI Studio is unlocked after you confirm your email.</p>
      </main>
    );
  }
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1 className="ds-h2">AI Studio</h1>
      <p className="ds-lede">Brainstorm ideas, titles, scripts, and thumbnails with a creative assistant.</p>
      <StudioRoot videoId={videoId} />
    </main>
  );
}
