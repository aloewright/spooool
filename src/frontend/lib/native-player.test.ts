import { describe, expect, it, vi } from 'vitest';
import { createNativePlayer } from './native-player';

// Minimal fake video.js Player surface — only the methods the adapter calls.
function makeFakePlayer(opts: { duration?: number; muted?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  let currentTime = 0;
  let muted = opts.muted ?? false;
  let paused = true;
  let disposed = false;
  let lastSrc: { src: string; type: string } | null = null;
  let fullscreen = false;

  const player = {
    src: vi.fn((s: { src: string; type: string }) => {
      lastSrc = s;
    }),
    currentTime: vi.fn((t?: number) => {
      if (typeof t === 'number') {
        currentTime = t;
        return undefined;
      }
      return currentTime;
    }),
    duration: vi.fn(() => opts.duration ?? 0),
    paused: vi.fn(() => paused),
    play: vi.fn(() => {
      paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      paused = true;
    }),
    muted: vi.fn((v?: boolean) => {
      if (typeof v === 'boolean') {
        muted = v;
        return undefined;
      }
      return muted;
    }),
    isFullscreen: vi.fn(() => fullscreen),
    requestFullscreen: vi.fn(() => {
      fullscreen = true;
      return Promise.resolve();
    }),
    exitFullscreen: vi.fn(() => {
      fullscreen = false;
      return Promise.resolve();
    }),
    readyState: vi.fn(() => 1),
    on: vi.fn((evt: string, h: () => void) => {
      const set = listeners.get(evt) ?? new Set<() => void>();
      set.add(h);
      listeners.set(evt, set);
    }),
    off: vi.fn((evt: string, h: () => void) => {
      listeners.get(evt)?.delete(h);
    }),
    dispose: vi.fn(() => {
      disposed = true;
    }),
    // Hooks for assertions.
    _state: () => ({ disposed, lastSrc, listeners }),
  };
  return player;
}

function makeElement(): HTMLVideoElement {
  const classes = new Set<string>();
  return {
    classList: {
      add: (c: string) => {
        classes.add(c);
      },
      contains: (c: string) => classes.has(c),
      remove: (c: string) => {
        classes.delete(c);
      },
    },
  } as unknown as HTMLVideoElement;
}

describe('createNativePlayer', () => {
  it('passes the source straight through to videojs and tags the element with the video-js class', () => {
    const player = makeFakePlayer();
    const el = makeElement();
    const factory = vi.fn(() => player as unknown as ReturnType<typeof import('video.js').default>);

    createNativePlayer(
      el,
      { src: 'https://x/m.m3u8', type: 'application/x-mpegURL' },
      { videojsFactory: factory },
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(player.src).toHaveBeenCalledWith({
      src: 'https://x/m.m3u8',
      type: 'application/x-mpegURL',
    });
    expect(el.classList.contains('video-js')).toBe(true);
  });

  it('coalesces NaN to 0 for currentTime and duration', () => {
    const player = makeFakePlayer({ duration: NaN });
    player.currentTime = vi.fn(() => NaN as unknown as number);
    const adapter = createNativePlayer(
      makeElement(),
      { src: 'x.mp4', type: 'video/mp4' },
      { videojsFactory: () => player as unknown as ReturnType<typeof import('video.js').default> },
    );
    expect(adapter.duration()).toBe(0);
    expect(adapter.currentTime()).toBe(0);
  });

  it('setCurrentTime / setMuted forward to the player', () => {
    const player = makeFakePlayer();
    const adapter = createNativePlayer(
      makeElement(),
      { src: 'x.mp4', type: 'video/mp4' },
      { videojsFactory: () => player as unknown as ReturnType<typeof import('video.js').default> },
    );
    adapter.setCurrentTime(42);
    adapter.setMuted(true);
    expect(player.currentTime).toHaveBeenCalledWith(42);
    expect(player.muted).toHaveBeenCalledWith(true);
  });

  it('on / off proxy to player.on / player.off', () => {
    const player = makeFakePlayer();
    const adapter = createNativePlayer(
      makeElement(),
      { src: 'x.mp4', type: 'video/mp4' },
      { videojsFactory: () => player as unknown as ReturnType<typeof import('video.js').default> },
    );
    const handler = (): void => {};
    adapter.on('loadedmetadata', handler);
    expect(player.on).toHaveBeenCalledWith('loadedmetadata', handler);
    adapter.off('loadedmetadata', handler);
    expect(player.off).toHaveBeenCalledWith('loadedmetadata', handler);
  });

  it('dispose tears down the player and is idempotent', () => {
    const player = makeFakePlayer();
    const adapter = createNativePlayer(
      makeElement(),
      { src: 'x.mp4', type: 'video/mp4' },
      { videojsFactory: () => player as unknown as ReturnType<typeof import('video.js').default> },
    );
    adapter.dispose();
    expect(player.dispose).toHaveBeenCalledTimes(1);
    adapter.dispose();
    expect(player.dispose).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from a player that has already been torn down', () => {
    const player = makeFakePlayer();
    player.dispose = vi.fn(() => {
      throw new Error('already disposed');
    });
    const adapter = createNativePlayer(
      makeElement(),
      { src: 'x.mp4', type: 'video/mp4' },
      { videojsFactory: () => player as unknown as ReturnType<typeof import('video.js').default> },
    );
    expect(() => adapter.dispose()).not.toThrow();
  });

  it('play resolves to a Promise even when the underlying player returns undefined', async () => {
    const player = makeFakePlayer();
    player.play = vi.fn(() => undefined as unknown as Promise<void>);
    const adapter = createNativePlayer(
      makeElement(),
      { src: 'x.mp4', type: 'video/mp4' },
      { videojsFactory: () => player as unknown as ReturnType<typeof import('video.js').default> },
    );
    await expect(adapter.play()).resolves.toBeUndefined();
  });
});
