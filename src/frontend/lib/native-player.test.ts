import { describe, expect, it, vi } from 'vitest';
import {
  attachSource,
  createNativePlayer,
  isHlsSource,
  nativeHlsSupported,
} from './native-player';

// Minimal fake HTMLVideoElement — only the surface our adapter touches.
function makeFakeVideo(opts: { canPlayHls?: boolean } = {}): HTMLVideoElement {
  const listeners = new Map<string, Set<EventListener>>();
  const fake = {
    src: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    muted: false,
    readyState: 0,
    controls: false,
    canPlayType: vi.fn((t: string) => {
      if (!opts.canPlayHls) return '';
      if (t === 'application/vnd.apple.mpegurl' || t === 'application/x-mpegURL') {
        return 'probably';
      }
      return '';
    }),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(function (this: { src: string }, attr: string) {
      if (attr === 'src') this.src = '';
    }),
    requestFullscreen: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn((type: string, l: EventListener) => {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(l);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, l: EventListener) => {
      listeners.get(type)?.delete(l);
    }),
  };
  // Bind removeAttribute's `this`.
  fake.removeAttribute = vi.fn((attr: string) => {
    if (attr === 'src') fake.src = '';
  });
  return fake as unknown as HTMLVideoElement;
}

class FakeHls {
  static isSupported = vi.fn(() => true);
  loadSource = vi.fn();
  attachMedia = vi.fn();
  destroy = vi.fn();
}

describe('isHlsSource', () => {
  it('detects the standard HLS MIME types', () => {
    expect(isHlsSource({ src: 'x', type: 'application/x-mpegURL' })).toBe(true);
    expect(isHlsSource({ src: 'x', type: 'application/vnd.apple.mpegurl' })).toBe(true);
  });

  it('detects .m3u8 by extension when MIME is wrong/missing', () => {
    expect(isHlsSource({ src: 'https://x/manifest.m3u8', type: '' })).toBe(true);
    expect(isHlsSource({ src: 'https://x/manifest.m3u8?token=abc', type: 'video/mp4' })).toBe(true);
    expect(isHlsSource({ src: 'https://x/manifest.m3u8#frag', type: 'video/mp4' })).toBe(true);
  });

  it('returns false for plain mp4', () => {
    expect(isHlsSource({ src: 'https://x/clip.mp4', type: 'video/mp4' })).toBe(false);
  });
});

describe('nativeHlsSupported', () => {
  it('returns true when canPlayType reports HLS', () => {
    expect(nativeHlsSupported(makeFakeVideo({ canPlayHls: true }))).toBe(true);
  });

  it('returns false when canPlayType returns empty', () => {
    expect(nativeHlsSupported(makeFakeVideo({ canPlayHls: false }))).toBe(false);
  });

  it('returns false when canPlayType is missing', () => {
    const broken = { canPlayType: undefined } as unknown as HTMLVideoElement;
    expect(nativeHlsSupported(broken)).toBe(false);
  });
});

describe('attachSource', () => {
  it('uses hls.js for HLS in non-Safari', () => {
    const el = makeFakeVideo({ canPlayHls: false });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const result = attachSource({
      element: el,
      source: { src: 'https://x/m.m3u8', type: 'application/x-mpegURL' },
      HlsCtor: FakeCtor,
    });
    expect(result.hls).toBeDefined();
    // Element src not assigned in the hls.js path.
    expect((el as unknown as { src: string }).src).toBe('');
  });

  it('sets element.src directly for HLS when native HLS is supported', () => {
    const el = makeFakeVideo({ canPlayHls: true });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const result = attachSource({
      element: el,
      source: { src: 'https://x/m.m3u8', type: 'application/x-mpegURL' },
      HlsCtor: FakeCtor,
    });
    expect(result.hls).toBeUndefined();
    expect((el as unknown as { src: string }).src).toBe('https://x/m.m3u8');
  });

  it('sets element.src directly for non-HLS sources', () => {
    const el = makeFakeVideo({ canPlayHls: false });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const result = attachSource({
      element: el,
      source: { src: 'https://x/clip.mp4', type: 'video/mp4' },
      HlsCtor: FakeCtor,
    });
    expect(result.hls).toBeUndefined();
    expect((el as unknown as { src: string }).src).toBe('https://x/clip.mp4');
  });
});

describe('createNativePlayer', () => {
  it('exposes getters that coalesce NaN to 0', () => {
    const el = makeFakeVideo({ canPlayHls: true });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const p = createNativePlayer(el, { src: 'x.mp4', type: 'video/mp4' }, { HlsCtor: FakeCtor });
    expect(p.duration()).toBe(0); // NaN before metadata
    expect(p.currentTime()).toBe(0);
    p.dispose();
  });

  it('setCurrentTime / setMuted write through to the element', () => {
    const el = makeFakeVideo({ canPlayHls: true });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const p = createNativePlayer(el, { src: 'x.mp4', type: 'video/mp4' }, { HlsCtor: FakeCtor });
    p.setCurrentTime(42);
    p.setMuted(true);
    expect((el as unknown as { currentTime: number }).currentTime).toBe(42);
    expect((el as unknown as { muted: boolean }).muted).toBe(true);
    p.dispose();
  });

  it('on / off proxy to addEventListener / removeEventListener', () => {
    const el = makeFakeVideo({ canPlayHls: true });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const p = createNativePlayer(el, { src: 'x.mp4', type: 'video/mp4' }, { HlsCtor: FakeCtor });
    const handler = (): void => {};
    p.on('loadedmetadata', handler);
    expect(el.addEventListener).toHaveBeenCalledWith('loadedmetadata', handler);
    p.off('loadedmetadata', handler);
    expect(el.removeEventListener).toHaveBeenCalledWith('loadedmetadata', handler);
    p.dispose();
  });

  it('dispose destroys the hls.js instance and releases the element', () => {
    const el = makeFakeVideo({ canPlayHls: false });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const p = createNativePlayer(
      el,
      { src: 'https://x/m.m3u8', type: 'application/x-mpegURL' },
      { HlsCtor: FakeCtor },
    );
    p.dispose();
    expect(el.pause).toHaveBeenCalled();
    expect(el.removeAttribute).toHaveBeenCalledWith('src');
    expect(el.load).toHaveBeenCalled();
  });

  it('dispose is idempotent', () => {
    const el = makeFakeVideo({ canPlayHls: true });
    const FakeCtor = FakeHls as unknown as typeof import('hls.js').default;
    const p = createNativePlayer(el, { src: 'x.mp4', type: 'video/mp4' }, { HlsCtor: FakeCtor });
    p.dispose();
    expect(() => p.dispose()).not.toThrow();
  });
});
