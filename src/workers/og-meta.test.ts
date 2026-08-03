import { describe, expect, it } from 'vitest';
import { buildOgCardSvg, buildOgMetaTags, clampForMeta, isPublicViewable, wrapSvgText } from './og-meta';

describe('wrapSvgText', () => {
  it('returns the input as a single line when it fits', () => {
    expect(wrapSvgText('short', 20, 3)).toEqual(['short']);
  });

  it('wraps on word boundaries when the line is too long', () => {
    const lines = wrapSvgText('one two three four five', 10, 3);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(11);
    }
  });

  it('caps at maxLines', () => {
    const text = 'word '.repeat(20).trim();
    const lines = wrapSvgText(text, 10, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('returns a single empty string for empty input', () => {
    expect(wrapSvgText('', 20, 3)).toEqual(['']);
  });
});

describe('buildOgCardSvg', () => {
  it('returns valid SVG markup', () => {
    const svg = buildOgCardSvg({ title: 'My Video', channelName: 'Alice' });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('includes the video title', () => {
    const svg = buildOgCardSvg({ title: 'Hello World', channelName: null });
    expect(svg).toContain('Hello World');
  });

  it('includes the channel name when provided', () => {
    const svg = buildOgCardSvg({ title: 'T', channelName: 'Bob' });
    expect(svg).toContain('Bob');
  });

  it('escapes XML characters in title and channel name', () => {
    const svg = buildOgCardSvg({ title: 'A & B <test>', channelName: '"quoted"' });
    expect(svg).toContain('A &amp; B &lt;test&gt;');
    expect(svg).toContain('&quot;quoted&quot;');
    expect(svg).not.toContain('<test>');
  });

  it('works without a channel name', () => {
    expect(() => buildOgCardSvg({ title: 'T' })).not.toThrow();
  });
});

describe('clampForMeta', () => {
  it('returns the empty string for null/undefined/empty input', () => {
    expect(clampForMeta(null, 100)).toBe('');
    expect(clampForMeta(undefined, 100)).toBe('');
    expect(clampForMeta('', 100)).toBe('');
  });

  it('passes short input through unchanged (after trim)', () => {
    expect(clampForMeta('  hi  ', 100)).toBe('hi');
  });

  it('truncates with an ellipsis past the cap', () => {
    expect(clampForMeta('a'.repeat(80), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('counts code points so emoji at the boundary survive intact', () => {
    // 🎬 is one code point but two UTF-16 code units. Cap=3 should yield
    // two emoji + ellipsis; no lone surrogate.
    const out = clampForMeta('🎬🎬🎬🎬', 3);
    expect([...out]).toHaveLength(3);
    for (const ch of out) {
      const code = ch.codePointAt(0) ?? 0;
      const isLoneSurrogate = code >= 0xd800 && code <= 0xdfff;
      expect(isLoneSurrogate).toBe(false);
    }
  });
});

describe('buildOgMetaTags', () => {
  const baseVideo = {
    title: 'My great video',
    description: 'A short summary.',
    thumbnail_url: 'https://thumbs.example/abc.jpg',
    channel_name: 'Alice',
  };

  it('emits og:* and twitter:* tags using the supplied origin and watch URL', () => {
    const out = buildOgMetaTags({
      origin: 'https://spooool.com',
      watchUrl: 'https://spooool.com/watch/abc',
      videoId: 'abc',
      video: baseVideo,
    });
    expect(out).toContain('<meta property="og:type" content="video.other" />');
    expect(out).toContain('<meta property="og:title" content="My great video" />');
    expect(out).toContain('<meta property="og:description" content="A short summary." />');
    expect(out).toContain('<meta property="og:url" content="https://spooool.com/watch/abc" />');
    expect(out).toContain('<meta property="og:image" content="https://thumbs.example/abc.jpg" />');
    expect(out).toContain('<meta property="og:site_name" content="Spooool" />');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('escapes XML metacharacters in title and description', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
      videoId: '1',
      video: { ...baseVideo, title: 'A & B "fun"', description: '<script>x</script>' },
    });
    expect(out).toContain('A &amp; B &quot;fun&quot;');
    expect(out).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('falls back to the generated OG card when no thumbnail is set', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
      videoId: 'vid-abc',
      video: { ...baseVideo, thumbnail_url: null },
    });
    expect(out).toContain('og:image" content="https://x.test/api/og/video/vid-abc"');
  });

  it('falls back the description to a sensible default when null', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
      videoId: '1',
      video: { ...baseVideo, description: null },
    });
    expect(out).toContain('Watch on Spooool — Alice');
  });

  it('truncates over-long titles and descriptions', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
      videoId: '1',
      video: { ...baseVideo, title: 'a'.repeat(120), description: 'b'.repeat(500) },
    });
    expect(out).toMatch(/og:title" content="a{69}…/);
    expect(out).toMatch(/og:description" content="b{199}…/);
  });
});

describe('isPublicViewable', () => {
  const baseRow = {
    id: 'v1',
    title: 't',
    description: null,
    thumbnail_url: null,
    status: 'ready' as string | null,
    hidden_at: null as string | null,
    dmca_status: null as string | null,
    deleted_at: null as string | null,
    channel_name: null as string | null,
  };

  it('passes ready, non-hidden, non-DMCA, non-deleted videos', () => {
    expect(isPublicViewable({ ...baseRow })).toBe(true);
  });

  it('rejects soft-deleted videos', () => {
    expect(isPublicViewable({ ...baseRow, deleted_at: '2026-05-01' })).toBe(false);
  });

  it('rejects hidden videos', () => {
    expect(isPublicViewable({ ...baseRow, hidden_at: '2026-05-01' })).toBe(false);
  });

  it('rejects DMCA-disabled videos', () => {
    expect(isPublicViewable({ ...baseRow, dmca_status: 'disabled' })).toBe(false);
  });

  it('rejects videos that are not yet ready', () => {
    expect(isPublicViewable({ ...baseRow, status: 'processing' })).toBe(false);
    expect(isPublicViewable({ ...baseRow, status: null })).toBe(false);
  });
});
