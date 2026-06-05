// HLS player for the R2+FFmpeg encoding path. Used in Watch.tsx when the
// video was encoded via the fallback container path (stream_video_id is null).
//
// Uses hls.js on browsers that don't natively support HLS (Chrome, Firefox)
// and falls back to native <video> on browsers that do (Safari, iOS).

import { useEffect, useRef, useCallback, type CSSProperties } from 'react';
import Hls from 'hls.js';

export interface HlsPlayerProps {
  src: string;
  startTime?: number;
  onReady?: () => void;
  onError?: (err: string) => void;
  style?: CSSProperties;
}

export function HlsPlayer({ src, startTime, onReady, onError, style }: HlsPlayerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const handleReady = useCallback(() => {
    const el = videoRef.current;
    if (el && startTime != null && startTime > 0) {
      el.currentTime = startTime;
    }
    onReady?.();
  }, [startTime, onReady]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({ startLevel: -1 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, handleReady);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          onError?.(`HLS fatal error: ${data.type} / ${data.details}`);
        }
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS: native HLS support
      video.src = src;
      video.addEventListener('loadedmetadata', handleReady, { once: true });
    }
  }, [src, handleReady, onError]);

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      style={{
        width: '100%',
        aspectRatio: '16 / 9',
        background: 'oklch(0 0 0)',
        display: 'block',
        ...style,
      }}
    />
  );
}
