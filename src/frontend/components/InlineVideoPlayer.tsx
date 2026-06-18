import { useEffect, useRef, useState, type JSX } from 'react';
import Hls from 'hls.js';
import { Video } from '@gfazioli/mantine-video';
import '@gfazioli/mantine-video/styles.css';
import type { FeedItem } from '../lib/feeds-client';
import { resolvePlayable, type Playable } from '../lib/discover-client';
import { YouTubeEmbed } from './YouTubeEmbed';

export function InlineVideoPlayer({ item }: { item: FeedItem }): JSX.Element {
  if (item.source === 'youtube' && item.embed?.kind === 'youtube') {
    return (
      <YouTubeEmbed
        videoId={item.embed.videoId}
        title={item.title}
        thumbnailUrl={item.thumbnailUrl}
      />
    );
  }
  return <CobaltPlayer item={item} />;
}

function CobaltPlayer({ item }: { item: FeedItem }): JSX.Element {
  const [playable, setPlayable] = useState<Playable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setPlayable(await resolvePlayable(item.url));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load video');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (playable?.kind !== 'hls' || !videoRef.current) return;
    const video = videoRef.current;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playable.url;
      return () => {
        video.removeAttribute('src');
        video.load();
      };
    }
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(playable.url);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
  }, [playable]);

  if (!playable) {
    return (
      <div className="feed-card__thumb-link">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="feed-card__thumb" loading="lazy" />
        ) : (
          <div className="feed-card__thumb feed-card__thumb--empty" />
        )}
        <button type="button" className="feed-card__play" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '▶ Play'}
        </button>
        {error && (
          <p className="ds-meta feed-card__error">
            {error} —{' '}
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              open original
            </a>
          </p>
        )}
      </div>
    );
  }

  if (playable.kind === 'hls') {
    return <video ref={videoRef} className="feed-card__video" controls autoPlay playsInline />;
  }
  return <Video src={playable.url} controls autoPlay />;
}
