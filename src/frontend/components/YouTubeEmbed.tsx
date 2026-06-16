import { useState, type JSX } from 'react';

interface YouTubeEmbedProps {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
}

// Privacy- and performance-friendly: render only a thumbnail until the user
// clicks, then swap in the youtube-nocookie iframe. No YouTube JS is loaded,
// so the CSP only needs frame-src https://www.youtube-nocookie.com.
export function YouTubeEmbed({ videoId, title, thumbnailUrl }: YouTubeEmbedProps): JSX.Element {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <div className="feed-embed feed-embed--youtube">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 8 }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="feed-embed feed-embed--placeholder"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${title}`}
      style={{
        position: 'relative', width: '100%', aspectRatio: '16 / 9', padding: 0, border: 0,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
        background: thumbnailUrl ? `center / cover no-repeat url(${thumbnailUrl})` : '#000',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        background: 'rgba(0,0,0,0.25)', color: '#fff', fontSize: 48,
      }}>▶</span>
    </button>
  );
}
