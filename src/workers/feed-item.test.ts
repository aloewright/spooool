import { describe, expect, it } from 'vitest';
import {
  assembleFeed,
  kvHash,
  parseSqliteTimestamp,
  canonicalKey,
  dedupeItems,
  interleaveRanked,
  assembleByRank,
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

function yt(videoId: string): FeedItem {
  return {
    source: 'youtube', id: videoId, title: videoId, author: 'a',
    thumbnailUrl: null, publishedAt: 0, durationSec: null,
    url: `https://www.youtube.com/watch?v=${videoId}`, embed: { kind: 'youtube', videoId },
  };
}
function web(id: string, url: string): FeedItem {
  return {
    source: 'web', id, title: id, author: 'a',
    thumbnailUrl: null, publishedAt: 0, durationSec: null, url,
  };
}

describe('canonicalKey', () => {
  it('keys youtube by videoId', () => {
    expect(canonicalKey(yt('abc'))).toBe('yt:abc');
  });
  it('keys web by host+path lowercased, www stripped', () => {
    expect(canonicalKey(web('1', 'https://WWW.Example.com/Watch?utm=x'))).toBe('example.com/watch');
  });
});

describe('dedupeItems', () => {
  it('drops later duplicates by canonical key', () => {
    const out = dedupeItems([yt('a'), web('1', 'https://e.com/x'), yt('a')]);
    expect(out.map((i) => i.id)).toEqual(['a', '1']);
  });
});

describe('interleaveRanked', () => {
  it('round-robins provider lists preserving rank', () => {
    const out = interleaveRanked([[yt('a1'), yt('a2')], [web('b1', 'https://e.com/b1')]]);
    expect(out.map((i) => i.id)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('assembleByRank', () => {
  it('interleaves, dedupes, paginates with a key cursor', () => {
    const lists = [[yt('a'), yt('c')], [yt('b'), yt('a')]];
    const p1 = assembleByRank(lists, null, 2);
    expect(p1.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = assembleByRank(lists, p1.nextCursor, 2);
    expect(p2.items.map((i) => i.id)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
  });

  it('returns empty page + null nextCursor when cursor key is not in the list (results churned)', () => {
    const lists = [[yt('a'), yt('b')]];
    const staleCursor = btoa('yt:nonexistent');
    const result = assembleByRank(lists, staleCursor, 10);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns empty page + null nextCursor for a malformed (non-base64) cursor', () => {
    const lists = [[yt('a'), yt('b')]];
    const result = assembleByRank(lists, '!!!not-base64!!!', 10);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns empty page + null nextCursor for empty input lists', () => {
    const result = assembleByRank([], null, 10);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
