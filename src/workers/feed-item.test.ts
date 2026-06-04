import { describe, expect, it } from 'vitest';
import {
  assembleFeed,
  kvHash,
  parseSqliteTimestamp,
  type FeedItem,
  type SourceResult,
} from './feed-item';

function item(source: FeedItem['source'], id: string, publishedAt: number): FeedItem {
  return {
    source,
    id,
    title: `title-${id}`,
    author: `author-${id}`,
    thumbnailUrl: null,
    publishedAt,
    durationSec: null,
    url: `https://example.com/${id}`,
  };
}

function result(sourceId: string, items: FeedItem[], extra: Partial<SourceResult> = {}): SourceResult {
  return { sourceId, kind: 'youtube_channel', items, ...extra };
}

describe('parseSqliteTimestamp', () => {
  it('parses a SQLite CURRENT_TIMESTAMP string as UTC', () => {
    const ms = parseSqliteTimestamp('2026-01-02 03:04:05');
    expect(ms).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('passes ISO strings through', () => {
    expect(parseSqliteTimestamp('2026-01-02T03:04:05Z')).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('returns 0 for unparseable input', () => {
    expect(parseSqliteTimestamp('not-a-date')).toBe(0);
  });
});

describe('kvHash', () => {
  it('is deterministic for the same input', () => {
    expect(kvHash('lofi beats')).toBe(kvHash('lofi beats'));
  });
  it('distinguishes inputs that share a long prefix (no cache-key collision)', () => {
    const base = 'x'.repeat(600);
    expect(kvHash(base + 'a')).not.toBe(kvHash(base + 'b'));
  });
  it('produces a short, key-safe token', () => {
    const h = kvHash('https://www.tiktok.com/@user/video/7300000000000000000');
    expect(h).toMatch(/^[a-z0-9]+$/);
    expect(h.length).toBeLessThanOrEqual(7);
  });
});

describe('assembleFeed', () => {
  it('merges across sources and sorts by publishedAt desc', () => {
    const out = assembleFeed(
      [result('s1', [item('youtube', 'a', 100), item('youtube', 'c', 300)]),
       result('s2', [item('spooool', 'b', 200)])],
      null,
      10,
    );
    expect(out.items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(out.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor and is stable across the boundary', () => {
    const items = [item('youtube', 'a', 500), item('youtube', 'b', 400), item('youtube', 'c', 300)];
    const page1 = assembleFeed([result('s1', items)], null, 2);
    expect(page1.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = assembleFeed([result('s1', items)], page1.nextCursor, 2);
    expect(page2.items.map((i) => i.id)).toEqual(['c']);
    expect(page2.nextCursor).toBeNull();
  });

  it('breaks publishedAt ties deterministically by id desc', () => {
    const out = assembleFeed([result('s1', [item('youtube', 'a', 100), item('youtube', 'b', 100)])], null, 10);
    expect(out.items.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('surfaces per-source error/stale flags without dropping other items', () => {
    const out = assembleFeed(
      [result('ok', [item('youtube', 'a', 100)]),
       result('bad', [], { error: 'quota' }),
       result('old', [item('spooool', 'b', 50)], { stale: true })],
      null,
      10,
    );
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(out.sources).toEqual([
      { sourceId: 'ok', kind: 'youtube_channel' },
      { sourceId: 'bad', kind: 'youtube_channel', error: 'quota' },
      { sourceId: 'old', kind: 'youtube_channel', stale: true },
    ]);
  });
});
