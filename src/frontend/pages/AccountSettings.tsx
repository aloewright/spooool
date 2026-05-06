import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut, useSession } from '../lib/auth-client';
import { ActiveSessions } from '../components/ActiveSessions';

interface AccountInfo {
  id: string;
  email: string;
  name: string;
  deletionRequestedAt: number | null;
  deletionScheduledFor: number | null;
}

export function AccountSettings(): JSX.Element {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [emailDraft, setEmailDraft] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void fetch('/api/account', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Account fetch failed: ${r.status}`);
        return (await r.json()) as AccountInfo;
      })
      .then((data) => {
        if (cancelled) return;
        setAccount(data);
        setEmailDraft(data.email);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const reload = async (): Promise<void> => {
    const r = await fetch('/api/account', { credentials: 'include' });
    if (r.ok) setAccount((await r.json()) as AccountInfo);
  };

  const updateEmail = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/email', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailDraft }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setInfo('Email updated.');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const updatePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/password', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setInfo('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setInfo('Deletion scheduled.');
      setConfirmDelete(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const cancelDelete = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/delete/cancel', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setInfo('Deletion cancelled.');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Sign in required.</p>
      </main>
    );
  }

  const scheduledDate =
    account?.deletionScheduledFor != null ? new Date(account.deletionScheduledFor) : null;

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">Account settings</h1>
        <p className="ds-lede">
          {/* LEGAL-REVIEW: confirm GDPR-compliant copy for the description and the delete confirm dialog. */}
          Manage your email, password, and account status.
        </p>
      </header>

      {error && <p className="status-error">{error}</p>}
      {info && <p className="ds-meta">{info}</p>}

      {scheduledDate && (
        <section className="stack-sm" aria-label="Deletion scheduled">
          <p className="status-error">
            {/* LEGAL-REVIEW: confirm the wording of the grace-window banner with counsel. */}
            Your account is scheduled for deletion on{' '}
            <strong>{scheduledDate.toUTCString()}</strong>. You can cancel any time before then.
          </p>
          <button type="button" className="btn btn--secondary" onClick={() => void cancelDelete()} disabled={busy}>
            Cancel deletion
          </button>
        </section>
      )}

      <section className="stack-sm" aria-label="Email">
        <span className="ds-label">Email</span>
        <form className="stack-sm" onSubmit={(e) => void updateEmail(e)}>
          <input
            type="email"
            className="input"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            required
          />
          <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
            Save email
          </button>
        </form>
      </section>

      <section className="stack-sm" aria-label="Password">
        <span className="ds-label">Password</span>
        <form className="stack-sm" onSubmit={(e) => void updatePassword(e)}>
          <input
            type="password"
            placeholder="Current password"
            className="input"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="New password (8+ characters)"
            className="input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
          <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
            Change password
          </button>
        </form>
      </section>

      <ActiveSessions />

      {!scheduledDate && (
        <section className="stack-sm" aria-label="Delete account">
          <span className="ds-label">Delete account</span>
          {/* LEGAL-REVIEW: confirm GDPR-compliant language for delete confirmation. */}
          <p className="ds-meta">
            Deletion is scheduled 30 days out. During that window you can sign back in and cancel. After the window,
            your videos, comments, and account are permanently removed.
          </p>
          {!confirmDelete ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(true)}>
              Delete my account…
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={busy}
                onClick={() =>
                  void requestDelete().then(() => signOut().then(() => navigate('/', { replace: true })))
                }
              >
                Confirm — schedule deletion
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setConfirmDelete(false)}
              >
                Keep my account
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
