// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createHtmlVideoAdapter } from './hls-player';

function makeVideo(): HTMLVideoElement & {
  _setPaused(value: boolean): void;
} {
  const video = document.createElement('video') as HTMLVideoElement & {
    _setPaused(value: boolean): void;
  };
  let paused = true;
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => paused,
  });
  Object.defineProperty(video, 'duration', { configurable: true, value: 90 });
  Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
  Object.defineProperty(video, 'play', {
    configurable: true,
    value: vi.fn(() => {
      paused = false;
      return Promise.resolve();
    }),
  });
  Object.defineProperty(video, 'pause', {
    configurable: true,
    value: vi.fn(() => {
      paused = true;
    }),
  });
  video._setPaused = (value: boolean): void => {
    paused = value;
  };
  return video;
}

describe('createHtmlVideoAdapter', () => {
  it('reads and writes currentTime + muted through the video element', () => {
    const video = makeVideo();
    video.currentTime = 12;
    video.muted = true;
    const player = createHtmlVideoAdapter(video);

    expect(player.currentTime()).toBe(12);
    expect(player.duration()).toBe(90);
    expect(player.muted()).toBe(true);

    player.setCurrentTime(42);
    expect(video.currentTime).toBe(42);
    player.setMuted(false);
    expect(video.muted).toBe(false);
  });

  it('coalesces NaN currentTime and duration to 0', () => {
    const video = makeVideo();
    Object.defineProperty(video, 'currentTime', { configurable: true, value: Number.NaN });
    Object.defineProperty(video, 'duration', { configurable: true, value: Number.NaN });
    const player = createHtmlVideoAdapter(video);

    expect(player.currentTime()).toBe(0);
    expect(player.duration()).toBe(0);
  });

  it('play/pause/paused proxy to the video element', async () => {
    const video = makeVideo();
    const player = createHtmlVideoAdapter(video);

    expect(player.paused()).toBe(true);
    await player.play();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(player.paused()).toBe(false);
    player.pause();
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(player.paused()).toBe(true);
  });

  it('on / off proxy to addEventListener / removeEventListener', () => {
    const video = makeVideo();
    const add = vi.spyOn(video, 'addEventListener');
    const remove = vi.spyOn(video, 'removeEventListener');
    const player = createHtmlVideoAdapter(video);
    const handler = (): void => {};

    player.on('loadedmetadata', handler);
    expect(add).toHaveBeenCalledWith('loadedmetadata', handler);
    player.off('loadedmetadata', handler);
    expect(remove).toHaveBeenCalledWith('loadedmetadata', handler);
  });

  it('dispose makes setters and event subscriptions no-ops', () => {
    const video = makeVideo();
    const add = vi.spyOn(video, 'addEventListener');
    const player = createHtmlVideoAdapter(video);

    player.dispose();
    player.setCurrentTime(99);
    player.pause();
    player.setMuted(true);
    player.on('play', () => {});

    expect(video.currentTime).toBe(0);
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.muted).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('reports the element readyState', () => {
    const player = createHtmlVideoAdapter(makeVideo());
    expect(player.readyState()).toBe(1);
  });

  describe('fullscreen', () => {
    it('isFullscreen() is true only when document.fullscreenElement === video', () => {
      const video = makeVideo();
      const player = createHtmlVideoAdapter(video);
      const restore = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');

      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      expect(player.isFullscreen()).toBe(false);
      Object.defineProperty(document, 'fullscreenElement', { value: video, configurable: true });
      expect(player.isFullscreen()).toBe(true);

      if (restore) Object.defineProperty(document, 'fullscreenElement', restore);
    });

    it('exitFullscreen() resolves when nothing is fullscreen', async () => {
      const video = makeVideo();
      const player = createHtmlVideoAdapter(video);
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });

      await expect(player.exitFullscreen()).resolves.toBeUndefined();
    });
  });
});
