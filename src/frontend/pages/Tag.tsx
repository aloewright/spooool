import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { VideoPlaceholderIcon } from '../components/Icons';

interface TagVideo {
  id: string;
  title: string;
  description: string;
  channel_name: string | null;
  channel_username: string | null;
  thumbnail_url: string | null;
  view_count: number;
  created_at: string;
}

interface TagResponse {
  tag: { slug: string; label: string };
  videos: TagVideo[];
}

export function Tag(): JSX.Element {
  const { slug = '' } = useParams<{ slug: string }>();
  const [data, setData] = useState<TagResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setData(null);
    setError(null);
    setNotFound(false);
    void fetch(`/api/tags/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (r.status === 404) {
          if (!cancelled) setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`Failed (${r.status})`);
        return (await r.json()) as TagResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (notFound) {
    return (
      <main className="app-main stack-lg">
        <h1 className="ds-h2">Tag not found</h1>
        <p className="ds-lede">There are no videos for this tag yet.</p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg fade-in">
      <header className="stack-sm">
        <span className="ds-label">Tag</span>
        <h1 className="ds-h2">{data?.tag.label ?? slug}</h1>
      </header>

      {error && <p className="status-error">{error}</p>}
      {data === null && !error && <p className="ds-empty">Loading…</p>}
      {data !== null && data.videos.length === 0 && (
        <p className="ds-empty">No videos use this tag yet.</p>
      )}

      {data && data.videos.length > 0 && (
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
          {data.videos.map((v) => (
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
                  {v.view_count} views
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
