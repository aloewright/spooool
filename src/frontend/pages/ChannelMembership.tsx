import { useCallback, useEffect, useState } from 'react';

// ALO-161: membership UI mounted as an in-page section inside <Channel/>.
// Two surfaces, branched on `isOwner`:
//   - viewer: list active tiers, "Join" button → POST checkout → redirect.
//   - owner: list all tiers (incl. archived), inline create/archive form.

interface PublicTier {
  id: string;
  channelUserId: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MembershipMe {
  active: boolean;
  isOwner: boolean;
  status: string | null;
  tierId: string | null;
  currentPeriodEnd: number | null;
}

function formatPrice(cents: number, currency: string, interval: 'month' | 'year'): string {
  const amount = (cents / 100).toLocaleString(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
  return `${amount} / ${interval}`;
}

export function ChannelMembership({
  username,
  isOwner,
}: {
  username: string;
  isOwner: boolean;
}): JSX.Element | null {
  const [tiers, setTiers] = useState<PublicTier[] | null>(null);
  const [me, setMe] = useState<MembershipMe | null>(null);
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Owners see the manage endpoint (includes archived rows); everyone else
  // sees the public listing.
  const tiersUrl = isOwner
    ? `/api/channels/${encodeURIComponent(username)}/membership/tiers/manage`
    : `/api/channels/${encodeURIComponent(username)}/membership/tiers`;

  const reloadTiers = useCallback(async () => {
    try {
      const res = await fetch(tiersUrl, { credentials: 'same-origin' });
      if (!res.ok) {
        setTiers([]);
        return;
      }
      const data = (await res.json()) as { tiers: PublicTier[] };
      setTiers(data.tiers);
    } catch {
      setTiers([]);
    }
  }, [tiersUrl]);

  useEffect(() => {
    if (!username) return;
    void reloadTiers();
  }, [username, reloadTiers]);

  useEffect(() => {
    if (!username || isOwner) {
      setMe(null);
      return;
    }
    let cancelled = false;
    void fetch(
      `/api/channels/${encodeURIComponent(username)}/membership/me`,
      { credentials: 'same-origin' },
    )
      .then(async (r) => (r.ok ? ((await r.json()) as MembershipMe) : null))
      .then((data) => {
        if (!cancelled && data) setMe(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [username, isOwner]);

  const subscribe = useCallback(
    async (tierId: string) => {
      setBusyTier(tierId);
      setError(null);
      try {
        const res = await fetch(
          `/api/channels/${encodeURIComponent(username)}/membership/checkout`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tierId }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string; code?: string }
            | null;
          if (res.status === 401) {
            setError('Sign in to join this channel.');
          } else if (body?.code === 'stripe_unconfigured') {
            setError('Memberships are not available right now. Please try again later.');
          } else {
            setError(body?.error ?? 'Could not start checkout.');
          }
          return;
        }
        const data = (await res.json()) as { url?: string };
        if (data.url) {
          window.location.href = data.url;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setBusyTier(null);
      }
    },
    [username],
  );

  const archive = useCallback(
    async (tierId: string) => {
      if (!window.confirm('Archive this tier? Existing members keep billing.')) return;
      setBusyTier(tierId);
      setError(null);
      try {
        const res = await fetch(
          `/api/channels/${encodeURIComponent(username)}/membership/tiers/${encodeURIComponent(tierId)}`,
          { method: 'DELETE', credentials: 'same-origin' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? 'Could not archive tier.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setBusyTier(null);
        await reloadTiers();
      }
    },
    [username, reloadTiers],
  );

  if (tiers === null) return null;
  if (!isOwner && tiers.length === 0) return null;

  const visibleTiers = isOwner ? tiers : tiers.filter((t) => !t.archived);

  return (
    <section
      id="membership"
      className="card stack-sm"
      aria-label="Memberships"
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="ds-h3" style={{ margin: 0 }}>Memberships</h2>
        {isOwner ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setCreateOpen((v) => !v)}
          >
            {createOpen ? 'Close' : 'New tier'}
          </button>
        ) : null}
      </div>

      {!isOwner && me?.active ? (
        <p className="status-ok">
          You are an active member{me.tierId ? ' on this channel' : ''}.
        </p>
      ) : null}

      {error ? <p className="status-error">{error}</p> : null}

      {visibleTiers.length === 0 ? (
        <p className="ds-empty">
          {isOwner
            ? 'No tiers yet. Click "New tier" to create one.'
            : 'No memberships available.'}
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          {visibleTiers.map((tier) => (
            <article
              key={tier.id}
              className="suggestion-card"
              data-testid="tier-card"
              style={{ opacity: tier.archived ? 0.6 : 1 }}
            >
              <div className="ds-label">{formatPrice(tier.priceCents, tier.currency, tier.interval)}</div>
              <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{tier.name}</div>
              {tier.description ? (
                <p className="ds-meta" style={{ marginTop: 4 }}>
                  {tier.description}
                </p>
              ) : null}
              <div style={{ marginTop: 'var(--space-2)' }}>
                {isOwner ? (
                  tier.archived ? (
                    <span className="ds-meta">Archived</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busyTier === tier.id}
                      onClick={() => void archive(tier.id)}
                    >
                      Archive
                    </button>
                  )
                ) : me?.active ? (
                  <span className="ds-meta">Active</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busyTier === tier.id}
                    onClick={() => void subscribe(tier.id)}
                  >
                    {busyTier === tier.id ? 'Loading…' : 'Join'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {isOwner && createOpen ? (
        <NewTierForm
          username={username}
          onCreated={async () => {
            setCreateOpen(false);
            await reloadTiers();
          }}
          onError={setError}
        />
      ) : null}
    </section>
  );
}

function NewTierForm({
  username,
  onCreated,
  onError,
}: {
  username: string;
  onCreated: () => Promise<void> | void;
  onError: (msg: string | null) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceDollars, setPriceDollars] = useState('5');
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      onError(null);
      const priceCents = Math.round(Number.parseFloat(priceDollars || '0') * 100);
      if (!Number.isFinite(priceCents) || priceCents < 50) {
        onError('Price must be at least $0.50');
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(
          `/api/channels/${encodeURIComponent(username)}/membership/tiers`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              description: description.trim(),
              priceCents,
              interval,
            }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          onError(body?.error ?? 'Could not create tier.');
          return;
        }
        await onCreated();
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setBusy(false);
      }
    },
    [name, description, priceDollars, interval, username, onCreated, onError],
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="stack-sm" data-testid="new-tier-form">
      <div className="field">
        <label className="field__label" htmlFor="tier-name">Tier name</label>
        <input
          id="tier-name"
          className="input"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="tier-description">Description</label>
        <textarea
          id="tier-description"
          className="input"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="field__label" htmlFor="tier-price">Price (USD)</label>
          <input
            id="tier-price"
            type="number"
            min="0.5"
            step="0.01"
            className="input"
            value={priceDollars}
            onChange={(e) => setPriceDollars(e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field__label" htmlFor="tier-interval">Billed</label>
          <select
            id="tier-interval"
            className="input"
            value={interval}
            onChange={(e) => setInterval(e.target.value as 'month' | 'year')}
          >
            <option value="month">Monthly</option>
            <option value="year">Yearly</option>
          </select>
        </div>
      </div>
      <div>
        <button type="submit" className="btn btn--sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create tier'}
        </button>
      </div>
    </form>
  );
}
