// ALO-204: drop-in replacement for the slice of the video.js Player API the
// Watch page actually uses, backed by a native <video> element + hls.js for
// HLS playback in browsers that don't natively support it (i.e. everything
// outside Safari / iOS).
//
// Why an adapter instead of touching <video> directly from the page?
// - Keeps the existing Watch.tsx event-handler shape (`player.on(...)`,
//   `player.currentTime(t)`) so the refactor diff stays focused on the
//   player wrapper, not every keyboard / heartbeat / seek call site.
// - Centralises HLS-vs-MP4-vs-native-HLS detection in one place.
// - Lets us unit-test the adapter without a real DOM by feeding a fake
//   element, rather than monkey-patching the Player module.
//
// Bundle savings: video.js is ~570KB raw / ~160KB gz; hls.js is ~120KB raw /
// ~38KB gz. ~3× smaller and we lose no functionality the watch page used.

// hls.light excludes the legacy MPEG-TS demuxer + alt-audio paths we don't
// need (Cloudflare Stream emits CMAF/fMP4). Cuts ~180KB raw vs the full
// build, taking the watch chunk from ~570KB (video.js) to ~330KB raw /
// ~105KB gz. The light bundle ships without typings; we re-use the main
// package's class type for parameter and return positions.
import type HlsType from 'hls.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- hls.js light subpath has no types
import HlsLight from 'hls.js/dist/hls.light.mjs';
const Hls = HlsLight as typeof HlsType;

export interface NativePlayerSource {
  src: string;
  /** MIME type — informational; we route on the URL/type pair. */
  type: string;
}

export type NativePlayerEvent =
  | 'loadedmetadata'
  | 'play'
  | 'pause'
  | 'ended'
  | 'timeupdate'
  | 'error';

// ALO-122 (E3): a single rendition reported by hls.js for ABR introspection.
// `index` is the position within the manifest's variant list; `bitrate` is in
// bps as advertised by the manifest. `width` / `height` come from the variant
// resolution attribute when present.
export interface RenditionInfo {
  index: number;
  bitrate: number;
  width?: number;
  height?: number;
}

export interface NativePlayer {
  /** Releases the hls.js instance and clears the source. Safe to call twice. */
  dispose(): void;

  /** Read the current playhead time in seconds. */
  currentTime(): number;
  /** Move the playhead to `t` seconds. */
  setCurrentTime(t: number): void;

  /** Total duration in seconds (NaN until `loadedmetadata` fires). */
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

  /**
   * ABR introspection (ALO-122 E3). Returns the manifest's variant list when
   * we're driving HLS via hls.js, or an empty list for native HLS / direct
   * sources where the browser hides ABR state. The returned objects are
   * stable snapshots — callers get a fresh array on each call.
   */
  levels(): RenditionInfo[];
  /**
   * Index of the variant currently being played, or -1 when ABR info is not
   * available (native HLS in Safari, direct R2 mp4, etc).
   */
  currentLevel(): number;

  on(event: NativePlayerEvent, handler: () => void): void;
  off(event: NativePlayerEvent, handler: () => void): void;
}

// `application/x-mpegURL` and `application/vnd.apple.mpegurl` are both used in
// the wild for HLS manifests. The `.m3u8` extension is the universal fallback.
export function isHlsSource(source: NativePlayerSource): boolean {
  if (source.type === 'application/x-mpegURL') return true;
  if (source.type === 'application/vnd.apple.mpegurl') return true;
  if (/\.m3u8(?:[?#]|$)/i.test(source.src)) return true;
  return false;
}

// Native HLS support is the Safari (desktop + iOS) path. We probe via
// `canPlayType` rather than UA sniffing so behaviour is correct in any
// future browser that ships native HLS.
export function nativeHlsSupported(element: HTMLMediaElement): boolean {
  if (typeof element.canPlayType !== 'function') return false;
  return (
    element.canPlayType('application/vnd.apple.mpegurl') !== '' ||
    element.canPlayType('application/x-mpegURL') !== ''
  );
}

interface AttachOptions {
  element: HTMLVideoElement;
  source: NativePlayerSource;
  /** Inject a fake Hls constructor for testing. */
  HlsCtor?: typeof Hls;
}

// We only touch a tiny slice of the hls.js Hls instance. Typing it via the
// shared interface (rather than reusing HlsType wholesale) avoids dragging
// the eventEmitter generics through callers and keeps the test fakes simple.
interface HlsInstance {
  destroy(): void;
  levels?: Array<{ bitrate?: number; width?: number; height?: number }>;
  currentLevel?: number;
}

interface AttachResult {
  /** hls.js instance we own and must destroy on dispose, if any. */
  hls?: HlsInstance;
}

// Installs the source on the element. Returns the hls.js instance (if one
// was created) so the adapter can destroy it on dispose.
export function attachSource(opts: AttachOptions): AttachResult {
  const { element, source } = opts;
  const HlsCtor = opts.HlsCtor ?? Hls;

  if (isHlsSource(source) && !nativeHlsSupported(element) && HlsCtor.isSupported()) {
    const hls = new HlsCtor() as unknown as HlsInstance & {
      loadSource: (src: string) => void;
      attachMedia: (el: HTMLMediaElement) => void;
    };
    hls.loadSource(source.src);
    hls.attachMedia(element);
    return { hls };
  }

  // Native HLS in Safari OR a non-HLS source (mp4 etc): just set src.
  element.src = source.src;
  return {};
}

export function createNativePlayer(
  element: HTMLVideoElement,
  source: NativePlayerSource,
  opts: { HlsCtor?: typeof Hls } = {},
): NativePlayer {
  const { hls } = attachSource({ element, source, HlsCtor: opts.HlsCtor });

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        hls?.destroy();
      } catch {
        // best-effort cleanup
      }
      try {
        element.pause();
        element.removeAttribute('src');
        element.load();
      } catch {
        // element may already be detached
      }
    },
    currentTime(): number {
      // HTMLMediaElement.currentTime is a number, but it can be NaN before
      // metadata loads. Coalesce so callers don't have to guard every read.
      const t = element.currentTime;
      return Number.isFinite(t) ? t : 0;
    },
    setCurrentTime(t: number): void {
      element.currentTime = t;
    },
    duration(): number {
      // NaN before loadedmetadata. Returning 0 matches the safest behaviour
      // for the keyboard / heartbeat guards on the watch page.
      const d = element.duration;
      return Number.isFinite(d) ? d : 0;
    },
    paused(): boolean {
      return element.paused;
    },
    play(): Promise<void> {
      return element.play();
    },
    pause(): void {
      element.pause();
    },
    muted(): boolean {
      return element.muted;
    },
    setMuted(value: boolean): void {
      element.muted = value;
    },
    isFullscreen(): boolean {
      return typeof document !== 'undefined' && document.fullscreenElement === element;
    },
    requestFullscreen(): Promise<void> {
      if (typeof element.requestFullscreen !== 'function') return Promise.resolve();
      return element.requestFullscreen();
    },
    exitFullscreen(): Promise<void> {
      if (typeof document === 'undefined' || typeof document.exitFullscreen !== 'function') {
        return Promise.resolve();
      }
      return document.exitFullscreen();
    },
    readyState(): number {
      return element.readyState;
    },
    levels(): RenditionInfo[] {
      const list = hls?.levels;
      if (!Array.isArray(list)) return [];
      return list.map((lvl, idx) => ({
        index: idx,
        bitrate: typeof lvl.bitrate === 'number' ? lvl.bitrate : 0,
        width: typeof lvl.width === 'number' ? lvl.width : undefined,
        height: typeof lvl.height === 'number' ? lvl.height : undefined,
      }));
    },
    currentLevel(): number {
      const lvl = hls?.currentLevel;
      return typeof lvl === 'number' ? lvl : -1;
    },
    on(event: NativePlayerEvent, handler: () => void): void {
      element.addEventListener(event, handler);
    },
    off(event: NativePlayerEvent, handler: () => void): void {
      element.removeEventListener(event, handler);
    },
  };
}
