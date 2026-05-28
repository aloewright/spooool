// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createStreamAdapter } from './stream-player';
import type { StreamPlayerApi } from '@cloudflare/stream-react';

/**
 * Stub of the Cloudflare Stream Player iframe API surface. Only the fields
 * createStreamAdapter touches are populated; the rest are spread in via
 * Partial<> so TS doesn't complain about the unused HTMLMediaElement-ish
 * properties (buffered, played, etc.).
 */
function makeFakeApi(initial: Partial<StreamPlayerApi> = {}): StreamPlayerApi & {
  _events: Map<string, Set<EventListener>>;
} {
  const events = new Map<string, Set<EventListener>>();
  const api = {
    currentTime: 0,
    duration: 0,
    paused: true,
    muted: false,
    volume: 1,
    playbackRate: 1,
    ended: false,
    autoplay: false,
    controls: true,
    loop: false,
    preload: 'metadata' as const,
    src: 'uid',
    videoHeight: 0,
    videoWidth: 0,
    buffered: { length: 0 } as unknown as TimeRanges,
    played: { length: 0 } as unknown as TimeRanges,
    play: vi.fn(() => {
      api.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      api.paused = true;
    }),
    addEventListener: vi.fn((event: string, handler: EventListener) => {
      const set = events.get(event) ?? new Set<EventListener>();
      set.add(handler);
      events.set(event, set);
    }),
    removeEventListener: vi.fn((event: string, handler: EventListener) => {
      events.get(event)?.delete(handler);
    }),
    ...initial,
    _events: events,
  };
  return api as unknown as StreamPlayerApi & { _events: Map<string, Set<EventListener>> };
}

describe('createStreamAdapter', () => {
  it('reads and writes currentTime + muted through the iframe API', () => {
    const api = makeFakeApi({ currentTime: 12, muted: true });
    const player = createStreamAdapter(api, null);
    expect(player.currentTime()).toBe(12);
    expect(player.muted()).toBe(true);

    player.setCurrentTime(42);
    expect(api.currentTime).toBe(42);
    player.setMuted(false);
    expect(api.muted).toBe(false);
  });

  it('coalesces NaN currentTime and duration to 0', () => {
    const api = makeFakeApi({ currentTime: Number.NaN, duration: Number.NaN });
    const player = createStreamAdapter(api, null);
    expect(player.currentTime()).toBe(0);
    expect(player.duration()).toBe(0);
  });

  it('play/pause/paused proxy to the iframe API', async () => {
    const api = makeFakeApi();
    const player = createStreamAdapter(api, null);
    expect(player.paused()).toBe(true);
    await player.play();
    expect(api.play).toHaveBeenCalledTimes(1);
    expect(player.paused()).toBe(false);
    player.pause();
    expect(api.pause).toHaveBeenCalledTimes(1);
    expect(player.paused()).toBe(true);
  });

  it('on / off proxy to addEventListener / removeEventListener', () => {
    const api = makeFakeApi();
    const player = createStreamAdapter(api, null);
    const handler = (): void => {};
    player.on('loadedmetadata', handler);
    expect(api.addEventListener).toHaveBeenCalledWith('loadedmetadata', handler);
    player.off('loadedmetadata', handler);
    expect(api.removeEventListener).toHaveBeenCalledWith('loadedmetadata', handler);
  });

  it('dispose makes setters and event subscriptions no-ops', () => {
    const api = makeFakeApi();
    const player = createStreamAdapter(api, null);
    player.dispose();
    player.setCurrentTime(99);
    player.pause();
    player.setMuted(true);
    player.on('play', () => {});
    expect(api.currentTime).toBe(0);
    expect(api.pause).not.toHaveBeenCalled();
    expect(api.muted).toBe(false);
    expect(api.addEventListener).not.toHaveBeenCalled();
  });

  it('readyState reports HAVE_METADATA (1) — the adapter is only minted post-loadedmetadata', () => {
    const player = createStreamAdapter(makeFakeApi(), null);
    expect(player.readyState()).toBe(1);
  });

  describe('fullscreen', () => {
    it('isFullscreen() is true only when document.fullscreenElement === container', () => {
      const container = {} as HTMLElement;
      const player = createStreamAdapter(makeFakeApi(), container);
      // Default: nothing fullscreen.
      const restore = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      expect(player.isFullscreen()).toBe(false);
      Object.defineProperty(document, 'fullscreenElement', { value: container, configurable: true });
      expect(player.isFullscreen()).toBe(true);
      if (restore) Object.defineProperty(document, 'fullscreenElement', restore);
    });

    it('requestFullscreen() resolves when there is no container (defensive)', async () => {
      const player = createStreamAdapter(makeFakeApi(), null);
      await expect(player.requestFullscreen()).resolves.toBeUndefined();
    });
  });
});
