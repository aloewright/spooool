import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeed, listFeeds, addSource, fetchFeedItems } from './feeds-client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });

function mockOnce(body: unknown, ok = true, status = 200): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok, status, json: async () => body,
  });
}

describe('feeds-client', () => {
  it('createFeed posts name + public flag', async () => {
    mockOnce({ feed: { id: 'f1', name: 'X', is_public: 0 } });
    const feed = await createFeed({ name: 'X' });
    expect(feed.id).toBe('f1');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('/api/feeds');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'X' });
  });

  it('listFeeds returns the feeds array', async () => {
    mockOnce({ feeds: [{ id: 'f1', name: 'X', is_public: 0 }] });
    expect(await listFeeds()).toHaveLength(1);
  });

  it('addSource posts kind + ref', async () => {
    mockOnce({ source: { id: 's1', kind: 'youtube_search', ref: 'cats', label: 'Search: cats' } });
    const s = await addSource('f1', { kind: 'youtube_search', ref: 'cats' });
    expect(s.kind).toBe('youtube_search');
  });

  it('fetchFeedItems returns items + nextCursor', async () => {
    mockOnce({ feed: { id: 'f1', name: 'X' }, items: [{ source: 'youtube', id: 'v' }], nextCursor: null, sources: [] });
    const out = await fetchFeedItems('f1');
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it('throws on a non-ok response', async () => {
    mockOnce({ error: 'nope' }, false, 400);
    await expect(createFeed({ name: '' })).rejects.toThrow();
  });
});
