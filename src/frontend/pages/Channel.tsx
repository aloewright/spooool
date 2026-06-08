import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { VideoPlaceholderIcon } from '../components/Icons';
import { formatCount } from '../lib/format';

interface ChannelHeader {
  id: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  subscriberCount: number;
  videoCount: number;
  totalViewCount: number;
}

interface ChannelProduct {
  id: string;
  kind: 'membership' | 'tip';
  name: string;
  description: string | null;
  amount_cents: number | null;
  currency: string;
  billing_interval: string | null;
}

interface ChannelVideo {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  status: string;
  view_count: number;
  created_at: string;
}

const PAGE_SIZE = 24;

export function Channel(): JSX.Element {
  const { username } = useParams<{ username: string }>();
  const { data: session } = useSession();
  const [header, setHeader] = useState<ChannelHeader | null>(null);
  const [videos, setVideos] = useState<ChannelVideo[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<{ subscribed: boolean; subscriberCount: number } | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [products, setProducts] = useState<ChannelProduct[]>([]);
  const [membershipBusy, setMembershipBusy] = useState<string | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipSuccess, setMembershipSuccess] = useState(false);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setVideos([]);
    setPage(1);
    setHasMore(true);
    void fetch(`/api/channels/${encodeURIComponent(username)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Channel not found' : 'Failed to load channel');
        return (await res.json()) as ChannelHeader;
      })
      .then((data) => {
        if (cancelled) return;
        setHeader(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load channel');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  useEffect(() => {
    if (!username || error) return;
    let cancelled = false;
    void fetch(
      `/api/channels/${encodeURIComponent(username)}/videos?page=${page}&limit=${PAGE_SIZE}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load videos');
        return (await res.json()) as { videos: ChannelVideo[] };
      })
      .then((data) => {
        if (cancelled) return;
        setVideos((prev) => (page === 1 ? data.videos : [...prev, ...data.videos]));
        setHasMore(data.videos.length === PAGE_SIZE);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load videos');
      });
    return () => {
      cancelled = true;
    };
  }, [username, page, error]);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    void fetch(
      `/api/channels/${encodeURIComponent(username)}/subscription`,
      { credentials: 'same-origin' },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load subscription');
        return (await r.json()) as { subscribed: boolean; subscriberCount: number };
      })
      .then((data) => {
        if (!cancelled) setSub(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [username]);

  const [searchParams, setSearchParams] = useState(() => new URLSearchParams(window.location.search));

  useEffect(() => {
    if (!username) return;
    void fetch(`/api/channels/${encodeURIComponent(username)}/products`)
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json() as { products: ChannelProduct[] };
        setProducts(data.products.filter((p) => p.kind === 'membership'));
      })
      .catch(() => undefined);
  }, [username]);

  useEffect(() => {
    if (searchParams.get('membership_success') === '1') {
      setMembershipSuccess(true);
      const next = new URLSearchParams(searchParams);
      next.delete('membership_success');
      window.history.replaceState(null, '', `?${next}`);
      setSearchParams(next);
    }
  }, []); // run once on mount

  const joinMembership = useCallback(async (productId: string): Promise<void> => {
    if (!username || membershipBusy) return;
    setMembershipBusy(productId);
    setMembershipError(null);
    try {
      const r = await fetch(`/api/channels/${encodeURIComponent(username)}/membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ product_id: productId }),
      });
      const data = await r.json() as { checkout_url?: string; error?: string };
      if (!r.ok) throw new Error(data.error ?? 'Failed');
      if (data.checkout_url) window.location.href = data.checkout_url;
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      setMembershipBusy(null);
    }
  }, [username, membershipBusy]);

  const toggleSubscribe = useCallback(async (): Promise<void> => {
    if (!username || subBusy) return;
    if (!session) {
      setSubError('Sign in to subscribe.');
      return;
    }
    const wasSubscribed = sub?.subscribed ?? false;
    setSubBusy(true);
    setSubError(null);
    try {
      const r = await fetch(
        `/api/channels/${encodeURIComponent(username)}/subscribe`,
        { method: wasSubscribed ? 'DELETE' : 'POST', credentials: 'same-origin' },
      );
      if (!r.ok) throw new Error('Failed to update subscription');
      setSub((s) => ({
        subscribed: !wasSubscribed,
        subscriberCount: Math.max(0, (s?.subscriberCount ?? 0) + (wasSubscribed ? -1 : 1)),
      }));
    } catch (err: unknown) {
      setSubError(err instanceof Error ? err.message : 'Failed to update subscription');
    } finally {
      setSubBusy(false);
    }
  }, [username, session, sub?.subscribed, subBusy]);

  if (loading && !header) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  if (error && !header) {
    return (
      <main className="app-main stack">
        <p className="status-error">{error}</p>
      </main>
    );
  }

  if (!header) return <main className="app-main stack" />;

  const isOwner = session?.user?.id === header.id;

  return (
    <main className="app-main stack-lg fade-in">
      {header.bannerUrl ? (
        <img
          src={header.bannerUrl}
          alt={`${header.displayName ?? 'channel'} banner`}
          decoding="async"
          fetchPriority="high"
          style={{ width: '100%', maxHeight: 240, objectFit: 'cover', borderRadius: 12 }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{
            width: '100%',
            height: 160,
            borderRadius: 12,
            background: 'linear-gradient(135deg, var(--color-strand-2), var(--color-strand-3))',
          }}
        />
      )}

      <header
        className="row"
        style={{ alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}
      >
        {header.avatarUrl ? (
          <img
            src={header.avatarUrl}
            alt=""
            decoding="async"
            fetchPriority="high"
            style={{ width: 96, height: 96, borderRadius: '50%', objectFit: 'cover' }}
          />
        ) : (
          <div
            aria-hidden="true"
            style={{
              width: 96,
              height: 96,
              borderRadius: '50%',
              background: 'var(--color-strand-3)',
            }}
          />
        )}
        <div className="stack-sm" style={{ flex: 1, minWidth: 220 }}>
          <h1 className="ds-h2" style={{ margin: 0 }}>
            {header.displayName ?? `@${header.username ?? 'unknown'}`}
          </h1>
          {header.username ? (
            <span className="ds-meta">@{header.username}</span>
          ) : null}
          <span className="ds-meta">
            {formatCount(sub?.subscriberCount ?? header.subscriberCount)} subscribers · {header.videoCount} videos · {formatCount(header.totalViewCount)} views
          </span>
        </div>
        {isOwner ? (
          <Link to="/profile">
            <button type="button" className="btn btn--secondary btn--sm">
              Edit channel
            </button>
          </Link>
        ) : (
          <button
            type="button"
            className={sub?.subscribed ? 'btn btn--secondary btn--sm' : 'btn btn--sm'}
            onClick={() => {
              void toggleSubscribe();
            }}
            disabled={subBusy}
            aria-pressed={sub?.subscribed ?? false}
          >
            {sub?.subscribed ? 'Subscribed' : 'Subscribe'}
          </button>
        )}
      </header>

      {subError ? <p className="status-error">{subError}</p> : null}
      {header.bio ? <p style={{ maxWidth: 720 }}>{header.bio}</p> : null}

      {membershipSuccess && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid color-mix(in oklch, var(--success, green), transparent 60%)',
            borderRadius: 'var(--radius-lg)',
            background: 'color-mix(in oklch, var(--success, green), transparent 90%)',
          }}
        >
          Membership activated — thank you for supporting this channel!
        </div>
      )}

      {!isOwner && products.length > 0 && (
        <section className="stack-sm" aria-label="Membership tiers">
          <h2 className="ds-h3">Membership</h2>
          <p className="ds-meta">Support this creator with a recurring membership.</p>
          {membershipError && <p className="status-error">{membershipError}</p>}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {products.map((product) => (
              <div key={product.id} className="card stack-sm" style={{ padding: 'var(--space-3)' }}>
                <div style={{ fontWeight: 700 }}>{product.name}</div>
                {product.description && (
                  <p className="ds-meta" style={{ margin: 0 }}>{product.description}</p>
                )}
                <div className="ds-meta">
                  {product.amount_cents != null
                    ? new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: product.currency.toUpperCase(),
                      }).format(product.amount_cents / 100)
                    : 'Custom price'}
                  {product.billing_interval ? `/${product.billing_interval}` : ''}
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={membershipBusy === product.id}
                  onClick={() => { void joinMembership(product.id); }}
                >
                  {membershipBusy === product.id ? 'Redirecting…' : 'Join'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stack-sm" aria-label="Videos">
        <h2 className="ds-h3">Videos</h2>
        {videos.length === 0 ? (
          <p className="ds-empty">No videos yet.</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {videos.map((video) => (
              <Link key={video.id} to={`/watch/${video.id}`} className="suggestion-card">
                {video.thumbnail_url ? (
                  <img
                    src={video.thumbnail_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{
                      width: '100%',
                      aspectRatio: '16/9',
                      objectFit: 'cover',
                      borderRadius: 8,
                      marginBottom: 'var(--space-2)',
                    }}
                  />
                ) : (
                  <VideoPlaceholderIcon />
                )}
                <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{video.title}</div>
                <div className="ds-meta" style={{ marginTop: 4 }}>
                  {formatCount(video.view_count)} views
                </div>
              </Link>
            ))}
          </div>
        )}

        {hasMore && videos.length > 0 ? (
          <div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPage((p) => p + 1)}
            >
              Load more
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
