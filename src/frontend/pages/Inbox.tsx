import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { VideoPlaceholderIcon } from '../components/Icons';

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

export function Inbox(): JSX.Element {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    const url = `/api/users/me/inbox${unseenOnly ? '?unseenOnly=1' : ''}`;
    void fetch(url, { credentials: 'include' })
      .then(async (r) => {
        if (r.status === 401) throw new Error('Sign in to see your inbox.');
        if (!r.ok) throw new Error('Failed to load inbox');
        return (await r.json()) as { items: InboxItem[] };
      })
      .then((data) => {
        if (!cancelled) setItems(data.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [unseenOnly]);

  useEffect(() => load(), [load]);

  const markAllSeen = async () => {
    setMarking(true);
    try {
      await fetch('/api/users/me/inbox/seen', { method: 'POST', credentials: 'include' });
      load();
    } finally {
      setMarking(false);
    }
  };

  return (
    <main className="app-main stack-lg fade-in">
      <header className="stack-sm" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <h1 className="ds-h2">Inbox</h1>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <label className="ds-meta" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={unseenOnly}
              onChange={(e) => setUnseenOnly(e.target.checked)}
            />
            Unseen only
          </label>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={markAllSeen}
            disabled={marking}
          >
            Mark all seen
          </button>
        </div>
      </header>

      {error && <p className="status-error">{error}</p>}
      {items === null && !error && <p className="ds-empty">Loading…</p>}
      {items !== null && items.length === 0 && (
        <p className="ds-empty">
          No new uploads from your subscriptions yet. Subscribe to a channel to see uploads here.
        </p>
      )}

      {items && items.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          {items.map((it) => (
            <li key={it.video_id}>
              <Link to={`/watch/${it.video_id}`} className="suggestion-card">
                {it.thumbnail_url ? (
                  <img
                    src={it.thumbnail_url}
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
                <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>
                  {it.seen_at === null && (
                    <span
                      aria-label="Unseen"
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--color-accent, #06f)',
                        marginRight: 6,
                        verticalAlign: 'middle',
                      }}
                    />
                  )}
                  {it.title}
                </div>
                <div className="ds-meta" style={{ marginTop: 4 }}>
                  {it.channel_name ?? it.channel_username ?? 'Unknown channel'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
