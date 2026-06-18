import { useEffect, useState, type JSX } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { createFeed, listFeeds, type Feed } from '../lib/feeds-client';

export function Feeds(): JSX.Element {
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void listFeeds()
      .then((f) => { if (!cancelled) setFeeds(f); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load feeds'); });
    return () => { cancelled = true; };
  }, []);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const feed = await createFeed({ name: name.trim() });
      void navigate({ to: '/feeds/$id', params: { id: feed.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create feed');
      setCreating(false);
    }
  }

  return (
    <main className="app-main stack-lg fade-in">
      <h1 className="ds-h2" style={{ margin: 0 }}>Your Feeds</h1>
      <p className="ds-meta" style={{ margin: 0 }}>
        Mix spooool channels, YouTube, and TikTok into one custom stream.
      </p>

      <form onSubmit={onCreate} className="stack-sm" style={{ maxWidth: 420 }}>
        <input
          className="ds-input"
          placeholder="New feed name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          aria-label="New feed name"
        />
        <button type="submit" className="ds-btn" disabled={!name.trim() || creating}>
          {creating ? 'Creating…' : 'Create feed'}
        </button>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
      {feeds === null && !error ? <p className="ds-empty">Loading…</p> : null}

      {feeds !== null && feeds.length === 0 ? (
        <p className="ds-empty">No feeds yet — create one above.</p>
      ) : null}

      {feeds !== null && feeds.length > 0 ? (
        <ul className="feed-list stack-sm" style={{ listStyle: 'none', padding: 0 }}>
          {feeds.map((f) => (
            <li key={f.id}>
              <Link to="/feeds/$id" params={{ id: f.id }} className="feed-list__item">
                <span className="feed-list__name">{f.name}</span>
                {f.is_public ? <span className="feed-badge">Public</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
