// Cloudflare Stream player wrapper. Spooool serves and uploads all video
// through Cloudflare Stream now (the video.js + HLS fallback was removed
// in ALO-???), so playback is a thin shell over @cloudflare/stream-react.
//
// The component exposes its underlying iframe player through an imperative
// `Player` adapter (created on `onLoadedMetaData`) so Watch.tsx's resume /
// heartbeat / keyboard hooks can keep their existing playerRef.current
// access pattern. If the Stream Player API surface ever grows or changes,
// the adapter is the only place to update.
import { Stream, type StreamPlayerApi } from '@cloudflare/stream-react';
import { useCallback, useEffect, useRef, type JSX } from 'react';

// Customer-scoped subdomain for the Stream iframe.
//   customer-<CODE>.cloudflarestream.com
// Same constant as src/workers/thumbnails.ts::STREAM_CUSTOMER_HOST; if the
// account ever migrates, update both call sites together.
const STREAM_CUSTOMER_CODE = 'od6lvjm5bwfl1lki';

export type PlayerEvent =
  | 'loadedmetadata'
  | 'play'
  | 'pause'
  | 'ended'
  | 'timeupdate'
  | 'error';

export interface Player {
  /** Releases the adapter. The iframe itself is torn down by React. */
  dispose(): void;

  currentTime(): number;
  setCurrentTime(t: number): void;

  duration(): number;

  paused(): boolean;
  play(): Promise<void>;
  pause(): void;

  muted(): boolean;
  setMuted(value: boolean): void;

  isFullscreen(): boolean;
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;

  readyState(): number;

  on(event: PlayerEvent, handler: () => void): void;
  off(event: PlayerEvent, handler: () => void): void;
}

export interface StreamPlayerProps {
  /** Cloudflare Stream video UID (or signed token). */
  videoId: string;
  /** Initial playhead in seconds. */
  startTime?: number;
  /** Fires once iframe metadata has loaded and the player is callable. */
  onReady: (player: Player) => void;
  /**
   * Fires before the videoId changes or the component unmounts, so callers
   * can null out their playerRef before the underlying iframe is replaced.
   */
  onTeardown: () => void;
  className?: string;
}

export function StreamPlayer(props: StreamPlayerProps): JSX.Element {
  const streamApiRef = useRef<StreamPlayerApi | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<Player | null>(null);
  // Hold callbacks in refs so handleLoadedMetaData stays stable across
  // re-renders without dropping subscriptions on the iframe.
  const onReadyRef = useRef(props.onReady);
  const onTeardownRef = useRef(props.onTeardown);
  onReadyRef.current = props.onReady;
  onTeardownRef.current = props.onTeardown;

  const handleLoadedMetaData = useCallback(() => {
    if (adapterRef.current) return;
    const api = streamApiRef.current;
    if (!api) return;
    const adapter = createStreamAdapter(api, containerRef.current);
    adapterRef.current = adapter;
    onReadyRef.current(adapter);
  }, []);

  useEffect(() => {
    return () => {
      if (!adapterRef.current) return;
      onTeardownRef.current();
      adapterRef.current.dispose();
      adapterRef.current = null;
    };
  }, [props.videoId]);

  return (
    <div ref={containerRef} className={props.className}>
      <Stream
        src={props.videoId}
        streamRef={streamApiRef}
        customerCode={STREAM_CUSTOMER_CODE}
        startTime={props.startTime}
        controls
        responsive
        onLoadedMetaData={handleLoadedMetaData}
      />
    </div>
  );
}

export function createStreamAdapter(api: StreamPlayerApi, container: HTMLElement | null): Player {
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    currentTime() {
      const t = api.currentTime;
      return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    },
    setCurrentTime(t) {
      if (disposed) return;
      api.currentTime = t;
    },
    duration() {
      const d = api.duration;
      return typeof d === 'number' && Number.isFinite(d) ? d : 0;
    },
    paused() {
      return Boolean(api.paused);
    },
    async play() {
      if (disposed) return;
      await api.play();
    },
    pause() {
      if (disposed) return;
      api.pause();
    },
    muted() {
      return Boolean(api.muted);
    },
    setMuted(value) {
      if (disposed) return;
      api.muted = value;
    },
    isFullscreen() {
      return Boolean(container && document.fullscreenElement === container);
    },
    requestFullscreen() {
      if (!container) return Promise.resolve();
      const result = container.requestFullscreen();
      return result instanceof Promise ? result : Promise.resolve();
    },
    exitFullscreen() {
      const result = document.exitFullscreen();
      return result instanceof Promise ? result : Promise.resolve();
    },
    readyState() {
      // The adapter is only minted on `loadedmetadata`, so HAVE_METADATA (1)
      // is the minimum. The Stream Player iframe doesn't expose the deeper
      // HTMLMediaElement readyState values, but Watch.tsx only branches on
      // `>= 1` (i.e. is metadata available yet) so the floor is enough.
      return 1;
    },
    on(event, handler) {
      if (disposed) return;
      api.addEventListener(event, handler as EventListener);
    },
    off(event, handler) {
      if (disposed) return;
      api.removeEventListener(event, handler as EventListener);
    },
  };
}
