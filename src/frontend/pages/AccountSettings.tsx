import { useEffect, useState, FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { resendVerificationEmail, useSession } from '../lib/auth-client';
import { signOutWithAnalyticsReset } from '../lib/auth-signout';
import { ActiveSessions } from '../components/ActiveSessions';
import { ConnectedAccounts } from '../components/ConnectedAccounts';

interface AccountInfo {
  id: string;
  email: string;
  name: string;
  deletionRequestedAt: number | null;
  deletionScheduledFor: number | null;
  notifyEmailNewUpload: boolean;
  notifyEmailComments: boolean;
  storage: { used: number; quota: number; remaining: number };
}

interface ChannelProduct {
  id: string;
  kind: 'membership' | 'tip';
  name: string;
  description: string | null;
  amount_cents: number | null;
  currency: string;
  billing_interval: string | null;
  active: number;
}

interface EarningsSummary {
  year: number;
  currency: string;
  grossEarningsUsd: number | null;
  netPayoutsUsd: number | null;
  taxDocStatus: 'polar-pending' | 'polar-issues';
  polar: {
    organizationId: string | null;
    accountStatus: 'not_connected' | 'pending' | 'active' | 'under_review';
    needsOnboarding: boolean;
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StorageBar({ used, quota }: { used: number; quota: number }): JSX.Element {
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const warn = pct >= 90;
  return (
    <div className="stack-sm">
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Storage used"
        style={{
          height: 6,
          borderRadius: 3,
          background: 'var(--color-border, #e0e0e0)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: warn ? 'var(--color-error, #d00)' : 'var(--color-primary, #555)',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <p className="ds-meta">
        {formatBytes(used)} of {formatBytes(quota)} used
        {warn && <strong> — storage nearly full</strong>}
      </p>
    </div>
  );
}

export function AccountSettings(): JSX.Element {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [earnings, setEarnings] = useState<EarningsSummary | null>(null);

  const [emailDraft, setEmailDraft] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailInfo, setEmailInfo] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordInfo, setPasswordInfo] = useState<string | null>(null);

  const [notifyNewUpload, setNotifyNewUpload] = useState(true);
  const [notifyComments, setNotifyComments] = useState(true);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [notifyInfo, setNotifyInfo] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [polarError, setPolarError] = useState<string | null>(null);

  // Product management
  const [products, setProducts] = useState<ChannelProduct[] | null>(null);
  const [productBusy, setProductBusy] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [productInfo, setProductInfo] = useState<string | null>(null);
  const [newProductKind, setNewProductKind] = useState<'tip' | 'membership'>('tip');
  const [newProductName, setNewProductName] = useState('');
  const [newProductDesc, setNewProductDesc] = useState('');
  const [newProductPolarId, setNewProductPolarId] = useState('');
  const [newProductPriceId, setNewProductPriceId] = useState('');
  const [newProductAmount, setNewProductAmount] = useState('');
  const [newProductInterval, setNewProductInterval] = useState<'' | 'month' | 'year'>('');
  const [showAddProduct, setShowAddProduct] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void Promise.all([
      fetch('/api/account', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) throw new Error(`Account fetch failed: ${r.status}`);
        return (await r.json()) as AccountInfo;
      }),
      fetch('/api/account/earnings', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as EarningsSummary;
      }),
    ])
      .then(([accountData, earningsData]) => {
        if (cancelled) return;
        setAccount(accountData);
        setEmailDraft(accountData.email);
        setNotifyNewUpload(accountData.notifyEmailNewUpload);
        setNotifyComments(accountData.notifyEmailComments);
        setEarnings(earningsData);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    void fetch('/api/account/products', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json() as { products: ChannelProduct[] };
        setProducts(data.products);
      })
      .catch(() => undefined);
  }, [session]);

  const reloadProducts = async (): Promise<void> => {
    const r = await fetch('/api/account/products', { credentials: 'include' });
    if (r.ok) {
      const data = await r.json() as { products: ChannelProduct[] };
      setProducts(data.products);
    }
  };

  const addProduct = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setProductError(null);
    setProductInfo(null);
    setProductBusy(true);
    try {
      const body: Record<string, unknown> = {
        kind: newProductKind,
        name: newProductName,
        polar_product_id: newProductPolarId,
        polar_price_id: newProductPriceId,
      };
      if (newProductDesc) body.description = newProductDesc;
      if (newProductAmount) body.amount_cents = Math.round(parseFloat(newProductAmount) * 100);
      if (newProductInterval) body.billing_interval = newProductInterval;
      const r = await fetch('/api/account/products', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setProductInfo('Product linked.');
      setShowAddProduct(false);
      setNewProductName('');
      setNewProductDesc('');
      setNewProductPolarId('');
      setNewProductPriceId('');
      setNewProductAmount('');
      setNewProductInterval('');
      await reloadProducts();
    } catch (err) {
      setProductError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setProductBusy(false);
    }
  };

  const removeProduct = async (id: string): Promise<void> => {
    setProductError(null);
    setProductBusy(true);
    try {
      const r = await fetch(`/api/account/products/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      await reloadProducts();
    } catch (err) {
      setProductError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setProductBusy(false);
    }
  };

  // Handle redirect params from the Polar OAuth callback.
  useEffect(() => {
    const connected = searchParams.get('polar_connected');
    const err = searchParams.get('polar_error');
    if (connected || err) {
      if (err) setPolarError(`Polar connection failed: ${err.replace(/_/g, ' ')}`);
      if (connected) {
        // Refresh earnings to show the updated Polar status.
        fetch('/api/account/earnings', { credentials: 'include' })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { if (data) setEarnings(data as EarningsSummary); })
          .catch(() => {});
      }
      const next = new URLSearchParams(searchParams);
      next.delete('polar_connected');
      next.delete('polar_error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const reload = async (): Promise<void> => {
    const r = await fetch('/api/account', { credentials: 'include' });
    if (r.ok) {
      const data = (await r.json()) as AccountInfo;
      setAccount(data);
      setNotifyNewUpload(data.notifyEmailNewUpload);
      setNotifyComments(data.notifyEmailComments);
    }
  };

  const updateEmail = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setEmailError(null);
    setEmailInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/email', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailDraft }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setEmailInfo('Email updated.');
      await reload();
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const updatePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/password', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setPasswordInfo('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const updateNotifications = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setNotifyError(null);
    setNotifyInfo(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/notifications', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notifyEmailNewUpload: notifyNewUpload, notifyEmailComments: notifyComments }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setNotifyInfo('Notification preferences saved.');
    } catch (err) {
      setNotifyError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = async (): Promise<void> => {
    setDeleteError(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setConfirmDelete(false);
      await reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const cancelDelete = async (): Promise<void> => {
    setDeleteError(null);
    setBusy(true);
    try {
      const r = await fetch('/api/account/delete/cancel', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      await reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed');
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
          Manage your email, password, notifications, and account settings.
        </p>
      </header>

      {loadError && <p className="status-error">{loadError}</p>}

      {scheduledDate && (
        <section className="stack-sm" aria-label="Deletion scheduled">
          <p className="status-error">
            Your account is scheduled for permanent deletion on{' '}
            <strong>{scheduledDate.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>.
            {' '}To cancel, sign back in before that date and click the button below.
          </p>
          {deleteError && <p className="status-error">{deleteError}</p>}
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
          {emailError && <p className="status-error">{emailError}</p>}
          {emailInfo && <p className="ds-meta">{emailInfo}</p>}
          <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
            Save email
          </button>
        </form>
        {session.user.emailVerified === false ? (
          <div className="stack-xs">
            <p className="ds-meta status-error">
              Email not verified. Check your inbox for a verification link.
            </p>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setResendStatus(null);
                void resendVerificationEmail(session.user.email).then((r) =>
                  setResendStatus(r.ok ? 'Verification email sent.' : r.error ?? 'Failed'),
                );
              }}
            >
              Resend verification email
            </button>
            {resendStatus ? <p className="ds-meta">{resendStatus}</p> : null}
          </div>
        ) : (
          <p className="ds-meta" style={{ color: 'var(--color-success, green)' }}>
            Email verified
          </p>
        )}
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
          {passwordError && <p className="status-error">{passwordError}</p>}
          {passwordInfo && <p className="ds-meta">{passwordInfo}</p>}
          <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
            Change password
          </button>
        </form>
      </section>

      <section className="stack-sm" aria-label="Notifications">
        <span className="ds-label">Email notifications</span>
        <form className="stack-sm" onSubmit={(e) => void updateNotifications(e)}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input
              type="checkbox"
              checked={notifyNewUpload}
              onChange={(e) => setNotifyNewUpload(e.target.checked)}
            />
            New uploads from channels you follow
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input
              type="checkbox"
              checked={notifyComments}
              onChange={(e) => setNotifyComments(e.target.checked)}
            />
            Comments on your videos
          </label>
          {notifyError && <p className="status-error">{notifyError}</p>}
          {notifyInfo && <p className="ds-meta">{notifyInfo}</p>}
          <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
            Save preferences
          </button>
        </form>
      </section>

      {account?.storage && (
        <section className="stack-sm" aria-label="Storage">
          <span className="ds-label">Storage</span>
          <StorageBar used={account.storage.used} quota={account.storage.quota} />
        </section>
      )}

      <ConnectedAccounts />

      <ActiveSessions />

      <section className="stack-sm" aria-label="Payout account">
        <span className="ds-label">Payout account</span>
        <p className="ds-meta">
          Connect your Polar account to receive creator payouts (tips, memberships). Polar acts as
          Merchant of Record and routes payouts via Stripe Connect.
        </p>

        {polarError && <p className="status-error">{polarError}</p>}

        {earnings?.polar.accountStatus === 'not_connected' && (
          <a href="/api/account/polar/connect" className="btn btn--secondary btn--sm">
            Connect with Polar
          </a>
        )}

        {earnings?.polar.accountStatus === 'pending' && (
          <div className="stack-sm">
            <p className="ds-meta">
              Your Polar account is connected but payout setup is incomplete. Complete your payout
              account on Polar to start receiving earnings.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <a
                href="https://polar.sh/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--secondary btn--sm"
              >
                Complete payout setup on Polar
              </a>
              <a href="/api/account/polar/connect" className="btn btn--ghost btn--sm">
                Re-check status
              </a>
            </div>
          </div>
        )}

        {earnings?.polar.accountStatus === 'active' && (
          <p className="ds-meta" style={{ color: 'var(--color-success, green)' }}>
            Payout account connected and active.
          </p>
        )}

        {earnings?.polar.accountStatus === 'under_review' && (
          <div className="stack-sm">
            <p className="ds-meta" style={{ borderLeft: '3px solid currentColor', paddingLeft: 'var(--space-2)' }}>
              <strong>Payout account under review.</strong> Polar / Stripe is verifying your
              identity. You may need to submit additional documentation. Check your{' '}
              <a
                href="https://polar.sh/dashboard"
                target="_blank"
                rel="noopener noreferrer"
              >
                Polar dashboard
              </a>{' '}
              for next steps, then re-check your status here.
            </p>
            <a href="/api/account/polar/connect" className="btn btn--ghost btn--sm">
              Re-check status
            </a>
          </div>
        )}
      </section>

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
        {earnings?.taxDocStatus === 'polar-pending' && (
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

      {earnings?.polar.accountStatus === 'active' && (
        <section className="stack-sm" aria-label="Monetization products">
          <span className="ds-label">Tips &amp; memberships</span>
          <p className="ds-meta">
            Link your Polar products to enable tipping and channel memberships. Create products in
            your{' '}
            <a href="https://polar.sh/dashboard" target="_blank" rel="noopener noreferrer">
              Polar dashboard
            </a>
            , then paste the product ID and price ID below. Tips use &ldquo;pay what you want&rdquo;
            Polar products; memberships use recurring subscription products.
          </p>

          {productError && <p className="status-error">{productError}</p>}
          {productInfo && <p className="ds-meta">{productInfo}</p>}

          {products && products.filter((p) => p.active).length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="info-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {products.filter((p) => p.active).map((p) => (
                    <tr key={p.id}>
                      <td className="ds-meta">{p.kind}</td>
                      <td>{p.name}</td>
                      <td className="ds-meta">
                        {p.amount_cents != null
                          ? new Intl.NumberFormat('en-US', {
                              style: 'currency',
                              currency: p.currency.toUpperCase(),
                            }).format(p.amount_cents / 100)
                          : 'Custom'}
                        {p.billing_interval ? `/${p.billing_interval}` : ''}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={productBusy}
                          onClick={() => { void removeProduct(p.id); }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!showAddProduct ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => { setShowAddProduct(true); setProductError(null); setProductInfo(null); }}
            >
              Add product
            </button>
          ) : (
            <form className="stack-sm" onSubmit={(e) => { void addProduct(e); }}>
              <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend className="ds-label" style={{ marginBottom: 'var(--space-2)' }}>
                  New product
                </legend>

                <div className="stack-sm">
                  <div>
                    <label className="ds-label" htmlFor="np-kind">Type</label>
                    <select
                      id="np-kind"
                      className="input"
                      value={newProductKind}
                      onChange={(e) => setNewProductKind(e.target.value as 'tip' | 'membership')}
                      style={{ marginTop: 'var(--space-1)' }}
                    >
                      <option value="tip">Tip (one-time, custom amount)</option>
                      <option value="membership">Membership (recurring)</option>
                    </select>
                  </div>

                  <div>
                    <label className="ds-label" htmlFor="np-name">Display name</label>
                    <input
                      id="np-name"
                      type="text"
                      className="input"
                      required
                      maxLength={200}
                      placeholder="e.g. Fan tier · $5/month"
                      value={newProductName}
                      onChange={(e) => setNewProductName(e.target.value)}
                      style={{ marginTop: 'var(--space-1)' }}
                    />
                  </div>

                  <div>
                    <label className="ds-label" htmlFor="np-desc">Description (optional)</label>
                    <input
                      id="np-desc"
                      type="text"
                      className="input"
                      maxLength={1000}
                      placeholder="What does this membership include?"
                      value={newProductDesc}
                      onChange={(e) => setNewProductDesc(e.target.value)}
                      style={{ marginTop: 'var(--space-1)' }}
                    />
                  </div>

                  <div>
                    <label className="ds-label" htmlFor="np-polar-product">Polar product ID</label>
                    <input
                      id="np-polar-product"
                      type="text"
                      className="input"
                      required
                      maxLength={200}
                      placeholder="prod_xxxxxxxxxxxxxxxxxxxxxxxx"
                      value={newProductPolarId}
                      onChange={(e) => setNewProductPolarId(e.target.value)}
                      style={{ marginTop: 'var(--space-1)' }}
                    />
                  </div>

                  <div>
                    <label className="ds-label" htmlFor="np-polar-price">Polar price ID</label>
                    <input
                      id="np-polar-price"
                      type="text"
                      className="input"
                      required
                      maxLength={200}
                      placeholder="price_xxxxxxxxxxxxxxxxxxxxxxxx"
                      value={newProductPriceId}
                      onChange={(e) => setNewProductPriceId(e.target.value)}
                      style={{ marginTop: 'var(--space-1)' }}
                    />
                  </div>

                  {newProductKind === 'membership' && (
                    <>
                      <div>
                        <label className="ds-label" htmlFor="np-amount">Price (USD)</label>
                        <input
                          id="np-amount"
                          type="number"
                          className="input"
                          min="1"
                          step="0.01"
                          placeholder="5.00"
                          value={newProductAmount}
                          onChange={(e) => setNewProductAmount(e.target.value)}
                          style={{ marginTop: 'var(--space-1)' }}
                        />
                      </div>
                      <div>
                        <label className="ds-label" htmlFor="np-interval">Billing interval</label>
                        <select
                          id="np-interval"
                          className="input"
                          value={newProductInterval}
                          onChange={(e) => setNewProductInterval(e.target.value as '' | 'month' | 'year')}
                          style={{ marginTop: 'var(--space-1)' }}
                        >
                          <option value="">— select —</option>
                          <option value="month">Monthly</option>
                          <option value="year">Yearly</option>
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </fieldset>

              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button type="submit" className="btn btn--secondary btn--sm" disabled={productBusy}>
                  Save product
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setShowAddProduct(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {!scheduledDate && (
        <section className="stack-sm" aria-label="Delete account">
          <span className="ds-label">Delete account</span>
          <p className="ds-meta">
            Your deletion request is held for 30 days. During that window you can sign back in and cancel at any time.
            After 30 days, your videos, profile, and account credentials are permanently deleted.
            Comments you posted remain on the platform but are anonymized — your name and account information are removed from them.
          </p>
          {deleteError && <p className="status-error">{deleteError}</p>}
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
                  void requestDelete().then(() => signOutWithAnalyticsReset().then(() => navigate('/', { replace: true })))
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
