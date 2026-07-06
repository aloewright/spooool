import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; email: string; name: string | null }
  | { phase: 'error'; message: string };

export function InviteAccept(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    if (!token) {
      setState({ phase: 'error', message: 'Invalid invite link.' });
      return;
    }
    fetch(`/api/invite/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json() as { ok?: boolean; email?: string; name?: string | null; error?: string };
        if (!res.ok || !data.ok) {
          const msg =
            res.status === 410 ? 'This invite link has already been used or has expired.'
            : res.status === 404 ? 'This invite link is not valid.'
            : (data.error ?? 'Something went wrong.');
          setState({ phase: 'error', message: msg });
        } else {
          setState({ phase: 'ready', email: data.email ?? '', name: data.name ?? null });
        }
      })
      .catch(() => setState({ phase: 'error', message: 'Could not reach the server. Try again.' }));
  }, [token]);

  function accept(): void {
    if (state.phase !== 'ready' || !token) return;
    const params = new URLSearchParams({ email: state.email });
    if (state.name) params.set('name', state.name);
    params.set('invite', token);
    navigate(`/signup?${params.toString()}`);
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in" style={{ paddingTop: 'var(--space-10)' }}>
      {state.phase === 'loading' && (
        <p className="ds-meta" style={{ textAlign: 'center' }}>Checking your invite…</p>
      )}

      {state.phase === 'error' && (
        <section className="card stack-sm" style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
          <h1 className="ds-h3">Invite not found</h1>
          <p className="ds-meta">{state.message}</p>
          <p className="ds-meta">
            <Link to="/waitlist" className="ds-link">Join the waitlist</Link>
            {' or '}
            <Link to="/signup" className="ds-link">sign up directly</Link>.
          </p>
        </section>
      )}

      {state.phase === 'ready' && (
        <section className="card stack" style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
          <div style={{ fontSize: 'var(--text-2xl)' }}>🎬</div>
          <h1 className="ds-h2">You're invited</h1>
          <p className="ds-lede" style={{ maxWidth: 440, margin: '0 auto' }}>
            {state.name ? `Hey ${state.name} — your` : 'Your'} spot on spooool is ready.
            Create your account to start uploading.
          </p>
          <p className="ds-meta" style={{ opacity: 0.7 }}>
            We'll sign you up as <strong>{state.email}</strong>.
          </p>
          <button type="button" className="btn" onClick={accept}>
            Create your account
          </button>
          <p className="ds-meta">
            <Link to="/login" className="ds-link">Already have an account? Sign in</Link>
          </p>
        </section>
      )}
    </main>
  );
}
