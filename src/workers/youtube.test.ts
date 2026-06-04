import { describe, expect, it } from 'vitest';
import {
  parseChannelInput,
  parsePlaylistInput,
  parseIso8601Duration,
  normalizePlaylistItem,
  normalizeSearchItem,
} from './youtube';

describe('parseChannelInput', () => {
  it('reads @handle (bare and URL)', () => {
    expect(parseChannelInput('@MrBeast')).toEqual({ by: 'handle', handle: 'MrBeast' });
    expect(parseChannelInput('https://www.youtube.com/@MrBeast')).toEqual({ by: 'handle', handle: 'MrBeast' });
  });
  it('reads /channel/UC… ids and bare UC ids', () => {
    const id = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
    expect(parseChannelInput(`https://youtube.com/channel/${id}`)).toEqual({ by: 'id', channelId: id });
    expect(parseChannelInput(id)).toEqual({ by: 'id', channelId: id });
  });
  it('reads legacy /user/NAME', () => {
    expect(parseChannelInput('https://www.youtube.com/user/PewDiePie')).toEqual({ by: 'username', username: 'PewDiePie' });
  });
  it('returns null for clearly invalid input', () => {
    expect(parseChannelInput('   ')).toBeNull();
    expect(parseChannelInput('https://example.com/foo')).toBeNull();
  });
});

describe('parsePlaylistInput', () => {
  it('extracts list= param', () => {
    expect(parsePlaylistInput('https://www.youtube.com/playlist?list=PLabc123')).toBe('PLabc123');
    expect(parsePlaylistInput('https://www.youtube.com/watch?v=x&list=UUxyz')).toBe('UUxyz');
  });
  it('accepts a bare playlist id', () => {
    expect(parsePlaylistInput('PLabc123')).toBe('PLabc123');
  });
  it('returns null otherwise', () => {
    expect(parsePlaylistInput('not a playlist')).toBeNull();
  });
});

describe('parseIso8601Duration', () => {
  it('parses H/M/S', () => {
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723);
    expect(parseIso8601Duration('PT45S')).toBe(45);
    expect(parseIso8601Duration('PT10M')).toBe(600);
  });
  it('returns null for junk', () => {
    expect(parseIso8601Duration('banana')).toBeNull();
  });
});

describe('normalizePlaylistItem', () => {
  it('maps a playlistItems.list entry to a FeedItem with a youtube embed', () => {
    const out = normalizePlaylistItem({
      snippet: {
        title: 'Cool Video',
        videoOwnerChannelTitle: 'Cool Channel',
        publishedAt: '2026-01-02T03:04:05Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } },
      },
      contentDetails: { videoId: 'abc123', videoPublishedAt: '2026-01-02T03:04:05Z' },
    });
    expect(out).toMatchObject({
      source: 'youtube',
      id: 'abc123',
      title: 'Cool Video',
      author: 'Cool Channel',
      thumbnailUrl: 'https://i.ytimg.com/x.jpg',
      url: 'https://www.youtube.com/watch?v=abc123',
      embed: { kind: 'youtube', videoId: 'abc123' },
    });
    expect(out!.publishedAt).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('returns null when the videoId is missing', () => {
    expect(normalizePlaylistItem({ snippet: {}, contentDetails: {} })).toBeNull();
  });
});

describe('normalizeSearchItem', () => {
  it('maps a search.list entry to a FeedItem', () => {
    const out = normalizeSearchItem({
      id: { videoId: 'srch1' },
      snippet: {
        title: 'Found It',
        channelTitle: 'Finder',
        publishedAt: '2026-02-02T00:00:00Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/s.jpg' } },
      },
    });
    expect(out).toMatchObject({ source: 'youtube', id: 'srch1', embed: { kind: 'youtube', videoId: 'srch1' } });
  });
});
