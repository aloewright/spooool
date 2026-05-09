import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { VideoPlaceholderIcon } from '../components/Icons';
import { formatViews } from '../lib/format-views';

interface SearchResult {
  id: string;
  title: string;
  description: string;
  channel_name: string | null;
  channel_username: string | null;
  thumbnail_url: string | null;
  view_count: number;
  created_at: string;
}

export function Search(): JSX.Element {
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    if (q.length === 0) return null;
    const u = new URL('/api/videos/search', window.location.origin);
    u.searchParams.set('q', q);
    return u.toString();
  }, [q]);

  useEffect(() => {
    if (!url) {
      setResults([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setResults(null);
    setError(null);
    void fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error('Search failed');
        return (await r.json()) as { videos: SearchResult[] };
      })
      .then((data) => {
        if (!cancelled) setResults(data.videos);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <main className="app-main stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h2">{q ? `Results for “${q}”` : 'Type a query'}</h1>
      </header>

      {error && <p className="status-error">{error}</p>}
      {results === null && !error && <p className="ds-empty">Searching…</p>}
      {results !== null && results.length === 0 && q.length > 0 && (
        <p className="ds-empty">No videos matched “{q}”.</p>
      )}

      {results && results.length > 0 && (
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
          {results.map((v) => (
            <li key={v.id}>
              <Link to={`/watch/${v.id}`} className="suggestion-card">
                {v.thumbnail_url ? (
                  <img
                    src={v.thumbnail_url}
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
                <div style={{ fontWeight: 700 }}>{v.title}</div>
                <div className="ds-meta" style={{ marginTop: 4 }}>
                  {v.channel_username ? (
                    <>
                      <Link to={`/channel/${v.channel_username}`}>
                        {v.channel_name ?? v.channel_username}
                      </Link>{' '}
                      ·{' '}
                    </>
                  ) : null}
                  {formatViews(v.view_count)}
                </div>
                {v.description && (
                  <p className="ds-meta" style={{ marginTop: 6 }}>
                    {v.description.slice(0, 140)}
                    {v.description.length > 140 ? '…' : ''}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
