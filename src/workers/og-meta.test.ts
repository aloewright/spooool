import { describe, expect, it } from 'vitest';
import { buildOgMetaTags, clampForMeta, isPublicViewable, ogImageUrl } from './og-meta';

describe('ogImageUrl', () => {
  it('appends resize params to videodelivery.net thumbnails', () => {
    const url = ogImageUrl(
      'https://videodelivery.net/abc123/thumbnails/thumbnail.jpg',
      'https://spooool.com',
    );
    expect(url).toBe(
      'https://videodelivery.net/abc123/thumbnails/thumbnail.jpg?width=1200&height=630&fit=crop',
    );
  });

  it('appends resize params to customer cloudflarestream.com subdomains', () => {
    const url = ogImageUrl(
      'https://customer-abc.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg',
      'https://spooool.com',
    );
    expect(url).toBe(
      'https://customer-abc.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?width=1200&height=630&fit=crop',
    );
  });

  it('passes non-Stream URLs through unchanged', () => {
    const raw = 'https://r2.example.com/thumbs/vid.jpg';
    expect(ogImageUrl(raw, 'https://spooool.com')).toBe(raw);
  });

  it('falls back to /icon.png when thumbnail is null', () => {
    expect(ogImageUrl(null, 'https://x.test')).toBe('https://x.test/icon.png');
  });

  it('returns the raw value when the URL is not parseable', () => {
    const bad = 'not a url';
    expect(ogImageUrl(bad, 'https://x.test')).toBe(bad);
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
      video: { ...baseVideo, title: 'A & B "fun"', description: '<script>x</script>' },
    });
    expect(out).toContain('A &amp; B &quot;fun&quot;');
    expect(out).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('falls back to a thumbnail of /icon.png when none is set', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
      video: { ...baseVideo, thumbnail_url: null },
    });
    expect(out).toContain('og:image" content="https://x.test/icon.png"');
  });

  it('falls back the description to a sensible default when null', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
      video: { ...baseVideo, description: null },
    });
    expect(out).toContain('Watch on Spooool — Alice');
  });

  it('truncates over-long titles and descriptions', () => {
    const out = buildOgMetaTags({
      origin: 'https://x.test',
      watchUrl: 'https://x.test/watch/1',
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
