// ALO-124: in-app surface for the subscription inbox. Lists unseen + recent
// items the fan-out DO has populated, lets the viewer mark everything as
// seen, and links each row to /watch/:id. The header badge in App.tsx polls
// /api/users/me/inbox/unseen-count for its dot.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

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

type Filter = 'all' | 'unseen';

async function loadInbox(filter: Filter): Promise<InboxResponse> {
  const qs = filter === 'unseen' ? '?unseenOnly=1' : '';
  const res = await fetch(`/api/users/me/inbox${qs}`, { credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Sign in to view your inbox.');
    }
    throw new Error('Failed to load inbox.');
  }
  return (await res.json()) as InboxResponse;
}

async function markAllSeen(): Promise<void> {
  const res = await fetch('/api/users/me/inbox/seen', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Failed to mark items as seen.');
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

export function Inbox(): JSX.Element {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (next: Filter): Promise<void> => {
    try {
      const data = await loadInbox(next);
      setItems(data.items);
      setError(null);
    } catch (err: unknown) {
      setItems([]);
      setError(err instanceof Error ? err.message : 'Failed to load inbox.');
    }
  }, []);

  useEffect(() => {
    void refresh(filter);
  }, [filter, refresh]);

  const onMarkAllSeen = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await markAllSeen();
      await refresh(filter);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to mark items as seen.');
    } finally {
      setBusy(false);
    }
  }, [busy, filter, refresh]);

  const unseenCount = (items ?? []).filter((i) => i.seen_at === null).length;

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h2" style={{ margin: 0 }}>Inbox</h1>
        <p className="ds-meta" style={{ margin: 0 }}>
          New uploads from creators you follow.
        </p>
      </header>

      <div
        className="row"
        style={{ gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
      >
        <div role="tablist" aria-label="Inbox filter" style={{ display: 'inline-flex', gap: 'var(--space-1)' }}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={filter === 'all' ? 'btn btn--secondary btn--sm' : 'btn btn--ghost btn--sm'}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unseen'}
            className={filter === 'unseen' ? 'btn btn--secondary btn--sm' : 'btn btn--ghost btn--sm'}
            onClick={() => setFilter('unseen')}
          >
            Unseen{unseenCount > 0 ? ` · ${unseenCount}` : ''}
          </button>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            void onMarkAllSeen();
          }}
          disabled={busy || unseenCount === 0}
        >
          Mark all as seen
        </button>
      </div>

      {error ? <p className="status-error">{error}</p> : null}

      {items === null ? (
        <p className="ds-empty">Loading…</p>
      ) : items.length === 0 ? (
        <p className="ds-empty">
          {filter === 'unseen'
            ? "You're all caught up — no unseen videos."
            : 'Nothing here yet. Subscribe to a creator and their new uploads will land here.'}
        </p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((item) => {
            const isUnseen = item.seen_at === null;
            return (
              <li
                key={item.video_id}
                style={{
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid color-mix(in oklch, var(--border), transparent 50%)',
                  background: isUnseen
                    ? 'color-mix(in oklch, var(--accent), transparent 92%)'
                    : 'transparent',
                }}
              >
                <Link
                  to={`/watch/${item.video_id}`}
                  className="row"
                  style={{
                    gap: 'var(--space-3)',
                    alignItems: 'flex-start',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  {item.thumbnail_url ? (
                    <img
                      src={item.thumbnail_url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: 200,
                        aspectRatio: '16/9',
                        objectFit: 'cover',
                        borderRadius: 'var(--radius-sm)',
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{item.title}</div>
                    <div className="ds-meta" style={{ marginTop: 4 }}>
                      {item.channel_name ?? 'Unknown channel'} · {formatRelative(item.added_at)}
                      {isUnseen ? <span aria-label="Unseen"> · ●</span> : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
