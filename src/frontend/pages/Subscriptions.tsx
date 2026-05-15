import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { VideoPlaceholderIcon } from '../components/Icons';
import { track } from '../lib/analytics';

interface InboxItem {
  video_id: string;
  channel_user_id: string;
  added_at: string;
  seen_at: string | null;
  title: string;
  thumbnail_url: string | null;
  video_created_at: string;
  channel_name: string | null;
  channel_username: string | null;
}

interface InboxResponse {
  items: InboxItem[];
  page: number;
  limit: number;
  unseenOnly: boolean;
}

const PAGE_LIMIT = 50;

function timeSince(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function Subscriptions(): JSX.Element {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/users/me/inbox?limit=${PAGE_LIMIT}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load subscriptions');
        return (await res.json()) as InboxResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        track('subscriptions_inbox_viewed', { count: data.items.length });
        // Fire-and-forget: clear the unseen badge for next visit. Failing
        // this call is non-fatal — the inbox itself loaded fine.
        void fetch('/api/users/me/inbox/seen', {
          method: 'POST',
          credentials: 'include',
        }).catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app-main stack">
      <h1 className="ds-h2" style={{ margin: 0 }}>Subscriptions</h1>
      <p className="ds-meta" style={{ margin: 0 }}>
        New videos from channels you follow.
      </p>

      {error ? <p className="status-error">{error}</p> : null}

      {items === null && !error ? <p className="ds-empty">Loading…</p> : null}

      {items !== null && items.length === 0 ? (
        <div className="ds-empty stack-sm">
          <p>You're not subscribed to any channels yet.</p>
          <p>
            <Link to="/">Browse trending videos</Link> to find creators worth following.
          </p>
        </div>
      ) : null}

      {items !== null && items.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          {items.map((item) => (
            <InboxCard key={item.video_id} item={item} />
          ))}
        </div>
      ) : null}
    </main>
  );
}

function InboxCard({ item }: { item: InboxItem }): JSX.Element {
  const channelHref = item.channel_username
    ? `/channel/${encodeURIComponent(item.channel_username)}`
    : null;
  return (
    <article className="suggestion-card">
      <Link to={`/watch/${item.video_id}`} aria-label={item.title}>
        {item.thumbnail_url ? (
          <img
            src={item.thumbnail_url}
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
        <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{item.title}</div>
      </Link>
      <div className="ds-meta" style={{ marginTop: 4, display: 'flex', gap: 'var(--space-2)' }}>
        {channelHref ? (
          <Link to={channelHref} style={{ color: 'inherit', textDecoration: 'underline' }}>
            {item.channel_name ?? item.channel_username}
          </Link>
        ) : (
          <span>{item.channel_name ?? 'Unknown channel'}</span>
        )}
        <span aria-hidden="true">·</span>
        <time dateTime={item.added_at}>{timeSince(item.added_at)}</time>
      </div>
    </article>
  );
}
