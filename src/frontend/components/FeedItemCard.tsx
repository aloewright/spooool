import { Link } from 'react-router-dom';
import type { FeedItem } from '../lib/feeds-client';
import { InlineVideoPlayer } from './InlineVideoPlayer';

function SourceBadge({ source }: { source: FeedItem['source'] }): JSX.Element {
  const label =
    source === 'spooool' ? 'spooool'
    : source === 'youtube' ? 'YouTube'
    : source === 'tiktok' ? 'TikTok'
    : source === 'dailymotion' ? 'DailyMotion'
    : 'Web';
  return <span className={`feed-badge feed-badge--${source}`}>{label}</span>;
}

function Meta({ item }: { item: FeedItem }): JSX.Element {
  return (
    <div className="feed-card__meta">
      <SourceBadge source={item.source} />
      <h3 className="feed-card__title">{item.title}</h3>
      <p className="ds-meta feed-card__author">{item.author}</p>
    </div>
  );
}

export function FeedItemCard({ item }: { item: FeedItem }): JSX.Element {
  // spooool: internal watch route (Stream player lives there).
  if (item.source === 'spooool') {
    return (
      <article className="feed-card feed-card--spooool">
        <Link to={item.url} className="feed-card__thumb-link">
          {item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt="" className="feed-card__thumb" loading="lazy" />
          ) : (
            <div className="feed-card__thumb feed-card__thumb--empty" />
          )}
        </Link>
        <Meta item={item} />
      </article>
    );
  }

  // Everything else plays inline via InlineVideoPlayer (YouTube iframe, else Cobalt).
  return (
    <article className={`feed-card feed-card--${item.source}`}>
      <InlineVideoPlayer item={item} />
      <Meta item={item} />
    </article>
  );
}
