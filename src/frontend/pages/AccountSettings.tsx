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

// ALO-165: Polar acts as Merchant of Record so we don't run our own sales-tax
// integration. The remaining surface is creator-side income reporting.
// We link out to Polar's tax-form docs from the Earnings card so creators
// can find region-appropriate forms (1099-K, DAC7, etc.). Update this
// constant if Polar restructures their docs.
const POLAR_TAX_DOCS_URL = 'https://docs.polar.sh/finance/tax-forms';

type CreatorEarnings = {
  lifetimeCents: number;
  byYear: Array<{ year: number; cents: number }>;
  currency: 'USD';
  formIssuance: 'platform' | 'polar' | 'none';
  notice: 'pending-polar' | 'self-report' | 'platform-issued';
};

function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function noticeCopy(notice: CreatorEarnings['notice']): string {
  // LEGAL-REVIEW: confirm the wording for the three issuance paths with
  // counsel before partner payouts go live. Keys are stable; copy may move.
  switch (notice) {
    case 'platform-issued':
      return 'spooool will issue a 1099-K to you for this calendar year. The form appears here once finalized.';
    case 'pending-polar':
      return 'Polar issues your tax form directly. Use the Polar dashboard link below to download it.';
    case 'self-report':
    default:
      return 'No platform-issued tax form yet. Use these totals when filing — they reflect payouts settled to you.';
  }
}

export function AccountSettings(): JSX.Element {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
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

  // ALO-165: load creator earnings totals so the dashboard surface exists
  // even before Polar partner payouts are live. The endpoint returns a
  // zero-state today; the contract is stable so this code keeps working
  // once payouts start landing in the ledger.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void fetch('/api/account/earnings', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Earnings fetch failed: ${r.status}`);
        return (await r.json()) as CreatorEarnings;
      })
      .then((data) => {
        if (!cancelled) setEarnings(data);
      })
      .catch(() => {
        // Earnings is non-critical for the rest of the page — swallow so
        // a transient backend hiccup doesn't blow up email / password UX.
        if (!cancelled) setEarnings(null);
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

      <section className="stack-sm" aria-label="Earnings and tax forms">
        <span className="ds-label">Earnings &amp; tax forms</span>
        {/* LEGAL-REVIEW: confirm copy with counsel before enabling for partner-program creators. */}
        <p className="ds-meta">
          Spooool&apos;s creator payouts run through Polar, our Merchant of
          Record. Polar collects and remits sales tax / VAT on purchases —
          you don&apos;t owe buyer-side tax on those amounts. The figures
          below are your <em>creator payouts</em>, useful for filing your
          own income tax.
        </p>
        {earnings === null ? (
          <p className="ds-empty">Loading earnings…</p>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              <div>
                <div className="ds-meta">Lifetime payouts</div>
                <div style={{ fontWeight: 700, fontSize: 'var(--text-xl)' }}>
                  {formatUsdCents(earnings.lifetimeCents)}
                </div>
              </div>
              {earnings.byYear.slice(0, 3).map((y) => (
                <div key={y.year}>
                  <div className="ds-meta">{y.year}</div>
                  <div style={{ fontWeight: 700, fontSize: 'var(--text-xl)' }}>
                    {formatUsdCents(y.cents)}
                  </div>
                </div>
              ))}
            </div>
            <p className="ds-meta">{noticeCopy(earnings.notice)}</p>
          </>
        )}
        <p className="ds-meta">
          For region-specific tax forms (1099-K in the US, DAC7 in the EU,
          etc.) see{' '}
          <a href={POLAR_TAX_DOCS_URL} target="_blank" rel="noopener noreferrer">
            Polar&apos;s tax-form documentation
          </a>
          {' · '}
          <a
            href="https://docs.polar.sh/features/partner-payouts"
            target="_blank"
            rel="noopener noreferrer"
          >
            Partner payouts
          </a>
          .
        </p>
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
