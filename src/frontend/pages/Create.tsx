import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { CreateRoot } from '../create';

export function Create(): JSX.Element {
  const location = useLocation();
  const { data: session, isPending } = useSession();
  if (isPending) return <p>Loading…</p>;
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
      <CreateRoot />
    </main>
  );
}
