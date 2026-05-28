import { describe, expect, it } from 'vitest';
import { buildThumbnailCandidates } from './thumbnails';

describe('buildThumbnailCandidates', () => {
  it('produces 3 timestamps spread across the video', () => {
    const result = buildThumbnailCandidates('abc123', 100);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?time=10s');
    expect(result[1]).toBe('https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?time=50s');
    expect(result[2]).toBe('https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?time=90s');
  });

  it('falls back to fixed timestamps when duration is missing', () => {
    const result = buildThumbnailCandidates('abc123', undefined);
    expect(result).toEqual([
      'https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?time=1s',
      'https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?time=3s',
      'https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?time=5s',
    ]);
  });

  it('clamps tiny videos to at least 1s', () => {
    const result = buildThumbnailCandidates('abc123', 2);
    for (const url of result) {
      expect(url).toMatch(/time=\d+s$/);
    }
    expect(result.every((u) => /time=[1-9]\d*s$/.test(u))).toBe(true);
  });
});
