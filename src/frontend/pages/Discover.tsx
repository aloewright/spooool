import { useState } from 'react';
import { FeedItemCard } from '../components/FeedItemCard';
import { searchDiscover, ALL_PROVIDERS, type ProviderKey, type DiscoverResponse } from '../lib/discover-client';
import type { FeedItem } from '../lib/feeds-client';

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  youtube: 'YouTube',
  dailymotion: 'DailyMotion',
  brave: 'Brave',
  firecrawl: 'Web',
};

export function Discover(): JSX.Element {
  const [q, setQ] = useState('');
  const [providers, setProviders] = useState<ProviderKey[]>([...ALL_PROVIDERS]);
  const [order, setOrder] = useState<'relevance' | 'date'>('relevance');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<DiscoverResponse['providers']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleProvider(p: ProviderKey) {
    setProviders((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
    setCursor(null);
    setItems([]);
  }

  async function run(reset: boolean) {
    if (!q.trim() || providers.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await searchDiscover({
        q,
        providers,
        order,
        cursor: reset ? undefined : cursor ?? undefined,
      });
      setItems((cur) => {
        if (reset) return res.items;
        const seen = new Set(cur.map((i) => `${i.source}:${i.id}`));
        return [...cur, ...res.items.filter((i) => !seen.has(`${i.source}:${i.id}`))];
      });
      setCursor(res.nextCursor);
      setStatus(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="discover">
      <h1>Discover</h1>
      <form
        className="discover__controls"
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
        <input
          className="discover__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search videos across the web…"
          aria-label="Search query"
        />
        <button type="submit" disabled={loading || !q.trim() || providers.length === 0}>
          Search
        </button>
      </form>

      <div className="discover__filters">
        {ALL_PROVIDERS.map((p) => (
          <label key={p} className="discover__chip">
            <input type="checkbox" checked={providers.includes(p)} onChange={() => toggleProvider(p)} />
            {PROVIDER_LABELS[p]}
          </label>
        ))}
        <label className="discover__chip">
          Order:
          <select value={order} onChange={(e) => { setOrder(e.target.value as 'relevance' | 'date'); setCursor(null); setItems([]); }}>
            <option value="relevance">Relevance</option>
            <option value="date">Newest</option>
          </select>
        </label>
      </div>

      {status.some((s) => s.error) && (
        <ul className="discover__provider-status">
          {status
            .filter((s) => s.error)
            .map((s) => (
              <li key={s.key} className="feed-badge feed-badge--error">
                {PROVIDER_LABELS[s.key]}: {s.error}
              </li>
            ))}
        </ul>
      )}

      {providers.length === 0 && <p className="discover__error">Select at least one source.</p>}
      {error && <p className="discover__error">{error}</p>}

      <div className="feed-grid">
        {items.map((item) => (
          <FeedItemCard key={`${item.source}:${item.id}`} item={item} />
        ))}
      </div>

      {cursor && (
        <button type="button" className="discover__more" onClick={() => void run(false)} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
