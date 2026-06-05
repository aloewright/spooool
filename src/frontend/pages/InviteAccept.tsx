import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

type InviteInfo = {
  code: string;
  wave: number;
  spotsLeft: number;
  expiresAt: number | null;
};

export function InviteAccept(): JSX.Element {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!code) {
      setError('No invite code provided.');
      setLoading(false);
      return;
    }
    void fetch(`/api/invite/${encodeURIComponent(code)}`)
      .then(async (res) => {
        const data = (await res.json()) as InviteInfo & { error?: string };
        if (!res.ok) {
          setError(data.error ?? 'Invite not found or no longer valid.');
          return;
        }
        setInfo(data);
      })
      .catch(() => setError('Failed to load invite. Check your connection.'))
      .finally(() => setLoading(false));
  }, [code]);

  function proceed(): void {
    navigate(`/signup?code=${encodeURIComponent(code ?? '')}`);
  }

  if (loading) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <p className="ds-meta" style={{ paddingTop: 'var(--space-8)' }}>Checking invite…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
          <span className="ds-label">Invite</span>
          <h1 className="ds-h2">Invite not valid</h1>
        </div>
        <p className="status-error">{error}</p>
        <p className="ds-meta">
          Want to get on the list?{' '}
          <Link to="/waitlist">Join the waitlist</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Beta invite</span>
        <h1 className="ds-h2">You're invited</h1>
        <p className="ds-lede" style={{ maxWidth: 460 }}>
          You've been invited to join the Spooool beta.
          Create your account to claim this invite.
        </p>
      </div>

      <div className="card stack-sm">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="ds-meta">Wave</span>
          <span>{info?.wave}</span>
        </div>
        {info?.expiresAt ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="ds-meta">Expires</span>
            <span>{new Date(info.expiresAt).toLocaleDateString()}</span>
          </div>
        ) : null}
      </div>

      <div className="row stack-sm" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/login" className="ds-meta">
          Already have an account? Sign in
        </Link>
        <button type="button" className="btn" onClick={proceed}>
          Create account
        </button>
      </div>
    </main>
  );
}
