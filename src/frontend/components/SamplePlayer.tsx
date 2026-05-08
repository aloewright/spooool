import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlayIcon } from './Icons';

// ALO-177: marketing-page sample player. The poster + play affordance is
// pure HTML/CSS so it costs nothing on first paint; on click the visitor
// is routed into the real /watch surface (which already lazy-loads hls.js,
// the player adapter, comments, etc.). Keeping the player wrapper out of
// the home shell preserves the LCP < 1.5s budget.
export type SamplePlayerProps = {
  videoId: string | null;
  posterUrl: string | null;
  title: string | null;
  channel: string | null;
};

export function SamplePlayer({ videoId, posterUrl, title, channel }: SamplePlayerProps): JSX.Element {
  // Pre-warm the watch chunk on hover so the click-to-navigate feels instant
  // without paying the import cost up front for visitors who never click.
  const [warmed, setWarmed] = useState(false);
  const warm = (): void => {
    if (warmed) return;
    setWarmed(true);
    void import('../pages/Watch').catch(() => undefined);
  };

  const target = videoId ? `/watch/${videoId}` : '/signup';
  const heading = title ?? 'spooool — a 30-second tour';
  const sub = channel ?? 'Sign up to start uploading';

  return (
    <Link
      to={target}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      className="landing__sample"
      aria-label={videoId ? `Play ${heading}` : 'Sign up to see spooool in action'}
    >
      <div
        className="landing__sample-frame"
        style={
          posterUrl
            ? { backgroundImage: `url(${posterUrl})` }
            : undefined
        }
      >
        <div className="landing__sample-overlay">
          <span className="landing__sample-play" aria-hidden="true">
            <PlayIcon />
          </span>
        </div>
      </div>
      <div className="landing__sample-meta">
        <div className="landing__sample-title">{heading}</div>
        <div className="ds-meta">{sub}</div>
      </div>
    </Link>
  );
}
