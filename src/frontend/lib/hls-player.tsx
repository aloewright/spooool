// HLS player for the R2+FFmpeg encoding path. Used in Watch.tsx when the
// video was encoded via the fallback container path (stream_video_id is null).
//
// Uses hls.js on browsers that don't natively support HLS (Chrome, Firefox)
// and falls back to native <video> on browsers that do (Safari, iOS).

import { useEffect, useRef, useCallback, type CSSProperties, type JSX } from 'react';
import Hls from 'hls.js';
import type { Player } from './stream-player';

export interface HlsPlayerProps {
  src: string;
  startTime?: number;
  onReady?: (player: Player) => void;
  onTeardown?: () => void;
  onError?: (err: string) => void;
  style?: CSSProperties;
}

export function HlsPlayer({
  src,
  startTime,
  onReady,
  onTeardown,
  onError,
  style,
}: HlsPlayerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const adapterRef = useRef<Player | null>(null);
  const onReadyRef = useRef(onReady);
  const onTeardownRef = useRef(onTeardown);
  onReadyRef.current = onReady;
  onTeardownRef.current = onTeardown;

  const handleReady = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (adapterRef.current) return;
    if (startTime != null && startTime > 0) {
      el.currentTime = startTime;
    }
    const adapter = createHtmlVideoAdapter(el);
    adapterRef.current = adapter;
    onReadyRef.current?.(adapter);
  }, [startTime]);

  const teardown = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    onTeardownRef.current?.();
    adapter.dispose();
    adapterRef.current = null;
  }, []);

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
        teardown();
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS: native HLS support
      video.src = src;
      video.addEventListener('loadedmetadata', handleReady, { once: true });
      return () => {
        teardown();
        video.removeAttribute('src');
      };
    }
    return () => {
      teardown();
    };
  }, [src, handleReady, onError, teardown]);

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

export function createHtmlVideoAdapter(video: HTMLVideoElement): Player {
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    currentTime() {
      const t = video.currentTime;
      return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    },
    setCurrentTime(t) {
      if (disposed) return;
      video.currentTime = t;
    },
    duration() {
      const d = video.duration;
      return typeof d === 'number' && Number.isFinite(d) ? d : 0;
    },
    paused() {
      return video.paused;
    },
    async play() {
      if (disposed) return;
      await video.play();
    },
    pause() {
      if (disposed) return;
      video.pause();
    },
    muted() {
      return video.muted;
    },
    setMuted(value) {
      if (disposed) return;
      video.muted = value;
    },
    isFullscreen() {
      return document.fullscreenElement === video;
    },
    requestFullscreen() {
      if (disposed) return Promise.resolve();
      const result = video.requestFullscreen();
      return result instanceof Promise ? result : Promise.resolve();
    },
    exitFullscreen() {
      if (disposed) return Promise.resolve();
      if (!document.fullscreenElement) return Promise.resolve();
      const result = document.exitFullscreen();
      return result instanceof Promise ? result : Promise.resolve();
    },
    readyState() {
      return video.readyState;
    },
    on(event, handler) {
      if (disposed) return;
      video.addEventListener(event, handler);
    },
    off(event, handler) {
      if (disposed) return;
      video.removeEventListener(event, handler);
    },
  };
}
