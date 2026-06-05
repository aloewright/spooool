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

interface EarningsSummary {
  year: number;
  currency: string;
  grossEarningsUsd: number | null;
  netPayoutsUsd: number | null;
  taxDocStatus: 'polar-pending' | 'polar-issues' | 'unknown';
}

export function AccountSettings(): JSX.Element {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [earnings, setEarnings] = useState<EarningsSummary | null>(null);
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
    void Promise.all([
      fetch('/api/account', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) throw new Error(`Account fetch failed: ${r.status}`);
        return (await r.json()) as AccountInfo;
      }),
      fetch('/api/account/earnings', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) return { taxDocStatus: 'unknown' } as EarningsSummary;
        return (await r.json()) as EarningsSummary;
      }),
    ])
      .then(([accountData, earningsData]) => {
        if (cancelled) return;
        setAccount(accountData);
        setEmailDraft(accountData.email);
        setEarnings(earningsData);
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

      <section className="stack-sm" aria-label="Earnings and taxes">
        <span className="ds-label">Earnings &amp; taxes</span>
        <p className="ds-meta">
          Spooool payouts are processed by{' '}
          <a
            href="https://docs.polar.sh/payments/taxes"
            target="_blank"
            rel="noopener noreferrer"
          >
            Polar
          </a>
          , which acts as Merchant of Record — Polar collects and remits sales tax
          and VAT on all transactions on your behalf. You do not need to register
          for Stripe Tax or file sales-tax returns for Spooool revenue.
        </p>

        <table style={{ borderCollapse: 'collapse', width: '100%' }} aria-label={`${earnings?.year ?? new Date().getUTCFullYear()} earnings summary`}>
          <thead>
            <tr>
              <th className="ds-meta" style={{ textAlign: 'left', paddingBottom: 'var(--space-1)' }}>
                {earnings?.year ?? new Date().getUTCFullYear()} (year to date)
              </th>
              <th className="ds-meta" style={{ textAlign: 'right', paddingBottom: 'var(--space-1)' }}>
                USD
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="ds-meta">Gross earnings (before fees)</td>
              <td className="ds-meta" style={{ textAlign: 'right' }}>
                {earnings?.grossEarningsUsd != null
                  ? `$${earnings.grossEarningsUsd.toFixed(2)}`
                  : '—'}
              </td>
            </tr>
            <tr>
              <td className="ds-meta">Net payouts received</td>
              <td className="ds-meta" style={{ textAlign: 'right' }}>
                {earnings?.netPayoutsUsd != null
                  ? `$${earnings.netPayoutsUsd.toFixed(2)}`
                  : '—'}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ALO-partner-tax: Polar does not yet issue 1099-K or 1099-MISC for
            creator partners in the US.  Remove this banner and update the copy
            below once Polar confirms 1099 delivery (set taxDocStatus to
            'polar-issues' in the /api/account/earnings response). */}
        {(earnings?.taxDocStatus === 'polar-pending' || earnings?.taxDocStatus === 'unknown') && (
          <p className="ds-meta" style={{ borderLeft: '3px solid currentColor', paddingLeft: 'var(--space-2)' }}>
            <strong>Note for US creators:</strong> Polar does not yet issue
            1099-K or 1099-MISC forms for creator partner payouts. You are
            responsible for reporting your Spooool earnings on your federal and
            state tax returns. Keep records of your gross earnings above — they
            are your primary documentation until Polar adds 1099 support.
            Spooool is tracking{' '}
            <a
              href="https://docs.polar.sh/payments/taxes"
              target="_blank"
              rel="noopener noreferrer"
            >
              Polar&apos;s tax documentation
            </a>{' '}
            and will update this page when the situation changes.
          </p>
        )}

        {earnings?.taxDocStatus === 'polar-issues' && (
          <p className="ds-meta">
            Polar issues 1099-K / 1099-MISC forms for eligible US creators.
            Log in to your{' '}
            <a
              href="https://polar.sh/dashboard"
              target="_blank"
              rel="noopener noreferrer"
            >
              Polar dashboard
            </a>{' '}
            to download your tax forms.
          </p>
        )}
      </section>

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
