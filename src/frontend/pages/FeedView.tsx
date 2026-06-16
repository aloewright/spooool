import { useCallback, useEffect, useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import {
  addSource,
  fetchFeedItems,
  removeSource,
  type FeedItem,
  type FeedItemsResponse,
  type FeedSourceKind,
} from '../lib/feeds-client';
import { ALL_PROVIDERS } from '../lib/discover-client';
import { FeedItemCard } from '../components/FeedItemCard';

const SOURCE_KINDS: Array<{ kind: FeedSourceKind; label: string; placeholder: string }> = [
  { kind: 'spooool_channel', label: 'spooool channel', placeholder: 'spooool username' },
  { kind: 'youtube_channel', label: 'YouTube channel', placeholder: 'channel URL or @handle' },
  { kind: 'youtube_playlist', label: 'YouTube playlist', placeholder: 'playlist URL' },
  { kind: 'youtube_search', label: 'YouTube search', placeholder: 'search terms' },
  { kind: 'tiktok_video', label: 'TikTok video', placeholder: 'tiktok.com video URL' },
  { kind: 'web_search', label: 'Web search', placeholder: 'Search query, e.g. lo-fi study beats' },
];

type FeedSize = 'xs' | 'sm' | 'md' | 'ml' | 'lg';

const FEED_SIZES: Array<{ value: FeedSize; label: string; minWidth: number }> = [
  { value: 'xs', label: 'Extra small', minWidth: 180 },
  { value: 'sm', label: 'Small', minWidth: 280 },
  { value: 'md', label: 'Medium', minWidth: 360 },
  { value: 'ml', label: 'Medium large', minWidth: 460 },
  { value: 'lg', label: 'Large', minWidth: 580 },
];

const FEED_SIZE_STORAGE_KEY = 'spooool.feedSize';

function isFeedSize(v: unknown): v is FeedSize {
  return typeof v === 'string' && FEED_SIZES.some((s) => s.value === v);
}

function loadFeedSize(): FeedSize {
  try {
    const stored = localStorage.getItem(FEED_SIZE_STORAGE_KEY);
    if (isFeedSize(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode / SSR) — fall through to default
  }
  return 'sm';
}

export function FeedView(): JSX.Element {
  const { id = '' } = useParams();
  const [data, setData] = useState<FeedItemsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<FeedSourceKind>('youtube_channel');
  const [ref, setRef] = useState('');
  const [adding, setAdding] = useState(false);
  const [size, setSize] = useState<FeedSize>(loadFeedSize);

  function onChangeSize(next: FeedSize): void {
    setSize(next);
    try {
      localStorage.setItem(FEED_SIZE_STORAGE_KEY, next);
    } catch {
      // ignore persistence failures
    }
  }

  const minCardWidth = FEED_SIZES.find((s) => s.value === size)?.minWidth ?? 280;

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setData(await fetchFeedItems(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed');
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void fetchFeedItems(id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load feed'); });
    return () => { cancelled = true; };
  }, [id]);

  async function onAddSource(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!ref.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      const refValue =
        kind === 'web_search'
          ? JSON.stringify({ q: ref.trim(), providers: [...ALL_PROVIDERS] })
          : ref.trim();
      await addSource(id, { kind, ref: refValue });
      setRef('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add source');
    } finally {
      setAdding(false);
    }
  }

  async function onRemoveSource(sourceId: string): Promise<void> {
    try {
      await removeSource(id, sourceId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source');
    }
  }

  const isOwner = data?.feed.is_owner === true;

  return (
    <main className="app-main stack-lg fade-in">
      <h1 className="ds-h2" style={{ margin: 0 }}>{data?.feed.name ?? 'Feed'}</h1>
      {data?.feed.description ? <p className="ds-meta">{data.feed.description}</p> : null}

      {error ? <p className="status-error">{error}</p> : null}

      {isOwner ? (
        <section className="stack-sm" aria-label="Manage sources">
          <form onSubmit={onAddSource} className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select className="ds-input" value={kind} onChange={(e) => setKind(e.target.value as FeedSourceKind)} aria-label="Source type">
              {SOURCE_KINDS.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
            </select>
            <input
              className="ds-input"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder={SOURCE_KINDS.find((s) => s.kind === kind)?.placeholder}
              aria-label="Source reference"
              style={{ flex: 1, minWidth: 200 }}
            />
            <button type="submit" className="ds-btn" disabled={!ref.trim() || adding}>
              {adding ? 'Adding…' : 'Add source'}
            </button>
          </form>

          {data && data.sources.length > 0 ? (
            <ul className="feed-sources" style={{ listStyle: 'none', padding: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {data.sources.map((s) => (
                <li key={s.sourceId} className={`feed-source-chip${s.error ? ' feed-source-chip--error' : ''}${s.stale ? ' feed-source-chip--stale' : ''}`}>
                  <span>{s.label || s.kind}</span>
                  {s.error ? <span className="ds-meta"> · unavailable</span> : s.stale ? <span className="ds-meta"> · cached</span> : null}
                  <button type="button" aria-label={`Remove ${s.label || s.kind}`} onClick={() => onRemoveSource(s.sourceId)} style={{ marginLeft: 6 }}>×</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {data === null && !error ? <p className="ds-empty">Loading…</p> : null}

      {data !== null && data.items.length === 0 ? (
        <p className="ds-empty">No videos yet. {isOwner ? 'Add a source above to start filling this feed.' : ''}</p>
      ) : null}

      {data !== null && data.items.length > 0 ? (
        <div className="feed-size-controls row" role="group" aria-label="Video size" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center', margin: 'var(--space-3) 0' }}>
          <span className="ds-meta">Size:</span>
          {FEED_SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`ds-btn${size === s.value ? ' ds-btn--active' : ''}`}
              aria-pressed={size === s.value}
              onClick={() => onChangeSize(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      {data !== null && data.items.length > 0 ? (
        <div className="feed-grid" style={{ display: 'grid', gap: 16, gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))` }}>
          {data.items.map((item: FeedItem) => (
            <FeedItemCard key={`${item.source}:${item.id}`} item={item} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
