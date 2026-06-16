import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { HlsPlayer } from '../lib/hls-player';
import { StreamPlayer, type Player } from '../lib/stream-player';

type VideoResponse = {
  id: string;
  title: string;
  channel_name?: string;
  channel_username?: string | null;
  stream_video_id?: string;
  status?: string;
};

export function Embed(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [video, setVideo] = useState<VideoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<Player | null>(null);

  useEffect(() => {
    if (!id) {
      setError('Missing video ID');
      return;
    }
    let ignore = false;
    void fetch(`/api/videos/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('Video not found');
        return (await r.json()) as VideoResponse;
      })
      .then((v) => {
        if (!ignore) setVideo(v);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Error');
      });
    return () => {
      ignore = true;
    };
  }, [id]);

  const handlePlayerReady = useCallback((p: Player): void => {
    playerRef.current = p;
  }, []);
  const handlePlayerTeardown = useCallback((): void => {
    playerRef.current = null;
  }, []);

  if (error) {
    return (
      <div
        style={{
          background: '#000',
          color: '#888',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'sans-serif',
          fontSize: 14,
        }}
      >
        <p>Video unavailable</p>
      </div>
    );
  }

  if (!video) {
    return <div style={{ background: '#000', height: '100vh' }} />;
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const watchUrl = `${origin}/watch/${video.id}`;
  const channelUrl =
    video.channel_username
      ? `${origin}/channel/${encodeURIComponent(video.channel_username)}`
      : watchUrl;

  return (
    <div
      style={{
        background: '#000',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {video.stream_video_id && video.status === 'ready' ? (
          <StreamPlayer
            videoId={video.stream_video_id}
            onReady={handlePlayerReady}
            onTeardown={handlePlayerTeardown}
          />
        ) : !video.stream_video_id && video.status === 'ready' ? (
          <HlsPlayer src={`/api/videos/${video.id}/hls/master.m3u8`} />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#888',
            }}
          >
            Video unavailable
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.85)',
        }}
      >
        <a
          href={watchUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: '#ddd',
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textDecoration: 'none',
            flex: 1,
            minWidth: 0,
          }}
        >
          {video.title}
        </a>
        <a
          href={channelUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: '#888',
            fontSize: 11,
            flexShrink: 0,
            textDecoration: 'none',
            letterSpacing: '0.02em',
          }}
        >
          spooool
        </a>
      </div>
    </div>
  );
}
