// ALO-204: thin adapter around video.js exposing only the slice of player
// behaviour Watch.tsx actually uses. We restored video.js (rolling back the
// hls.js swap from PR #57) because the long-term player roadmap depends on
// video.js's plugin host — captions, quality menu, marker / chapters, ad
// insertion all live in that ecosystem.
//
// The adapter shape is preserved so Watch.tsx and its tests don't have to
// learn the video.js API surface. It also gives us a single place to swap
// engines again without churning every keyboard / heartbeat / seek call site.
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
// ALO-141: Strand-themed skin layered on top of the default video.js CSS.
import '../styles/video-js-strand.css';

// video.js 8 ships its own types but doesn't export the Player class directly
// for downstream typing. ReturnType is the documented escape hatch.
type VjsPlayer = ReturnType<typeof videojs>;

export interface NativePlayerSource {
  src: string;
  /** MIME type — passed straight to video.js so VHS can route HLS sources. */
  type: string;
}

export type NativePlayerEvent =
  | 'loadedmetadata'
  | 'play'
  | 'pause'
  | 'ended'
  | 'timeupdate'
  | 'error';

export interface NativePlayer {
  /** Releases the underlying player. Safe to call twice. */
  dispose(): void;

  /** Read the current playhead time in seconds. */
  currentTime(): number;
  /** Move the playhead to `t` seconds. */
  setCurrentTime(t: number): void;

  /** Total duration in seconds (0 until `loadedmetadata` fires). */
  duration(): number;

  paused(): boolean;
  play(): Promise<void>;
  pause(): void;

  muted(): boolean;
  setMuted(value: boolean): void;

  isFullscreen(): boolean;
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;

  /** Mirrors HTMLMediaElement.readyState (HAVE_NOTHING ... HAVE_ENOUGH_DATA). */
  readyState(): number;

  on(event: NativePlayerEvent, handler: () => void): void;
  off(event: NativePlayerEvent, handler: () => void): void;
}

// Test seam: callers (and tests) may inject a stand-in for the videojs factory
// to avoid spinning up a real player against a fake DOM.
type VideoJsFactory = (
  el: Element,
  options?: Record<string, unknown>,
) => VjsPlayer;

interface CreateOptions {
  videojsFactory?: VideoJsFactory;
}

export function createNativePlayer(
  element: HTMLVideoElement,
  source: NativePlayerSource,
  opts: CreateOptions = {},
): NativePlayer {
  const factory: VideoJsFactory = opts.videojsFactory ?? (videojs as unknown as VideoJsFactory);

  // video.js looks for the `video-js` class to apply its skin. Adding it here
  // means the JSX call site doesn't have to know about the player engine.
  if (!element.classList.contains('video-js')) {
    element.classList.add('video-js');
  }

  const player = factory(element, {
    controls: true,
    preload: 'metadata',
    fluid: false,
    // VHS handles HLS in browsers without native support. `overrideNative`
    // forces VHS even on Safari, which keeps ABR / heartbeat behaviour
    // identical across browsers (Safari's native HLS doesn't expose the
    // hooks video.js plugins rely on).
    html5: { vhs: { overrideNative: true } },
  });
  player.src({ src: source.src, type: source.type });

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        player.dispose();
      } catch {
        // already torn down — best-effort cleanup
      }
    },
    currentTime(): number {
      const t = player.currentTime();
      return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    },
    setCurrentTime(t: number): void {
      player.currentTime(t);
    },
    duration(): number {
      const d = player.duration();
      return typeof d === 'number' && Number.isFinite(d) ? d : 0;
    },
    paused(): boolean {
      return player.paused();
    },
    play(): Promise<void> {
      const result = player.play();
      return result instanceof Promise ? result : Promise.resolve();
    },
    pause(): void {
      player.pause();
    },
    muted(): boolean {
      return player.muted() ?? false;
    },
    setMuted(value: boolean): void {
      player.muted(value);
    },
    isFullscreen(): boolean {
      return player.isFullscreen() ?? false;
    },
    requestFullscreen(): Promise<void> {
      const result = player.requestFullscreen();
      return result instanceof Promise ? result : Promise.resolve();
    },
    exitFullscreen(): Promise<void> {
      const result = player.exitFullscreen();
      return result instanceof Promise ? result : Promise.resolve();
    },
    readyState(): number {
      return player.readyState();
    },
    on(event: NativePlayerEvent, handler: () => void): void {
      player.on(event, handler);
    },
    off(event: NativePlayerEvent, handler: () => void): void {
      player.off(event, handler);
    },
  };
}
