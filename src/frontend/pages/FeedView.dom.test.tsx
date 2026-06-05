// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { FeedView } from './FeedView';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mountAt(path: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/feeds/:id" element={<FeedView />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

describe('FeedView page', () => {
  it('renders the feed name and its items', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        feed: { id: 'f1', name: 'Morning Watch', is_public: 0, is_owner: true },
        items: [
          { source: 'youtube', id: 'y1', title: 'YT Vid', author: 'C', thumbnailUrl: null, publishedAt: 2, durationSec: null, url: 'u', embed: { kind: 'youtube', videoId: 'y1' } },
          { source: 'tiktok', id: 't1', title: 'TT Vid', author: 'D', thumbnailUrl: null, publishedAt: 1, durationSec: null, url: 'https://www.tiktok.com/@d/video/1' },
        ],
        nextCursor: null,
        sources: [],
      }),
    });
    mountAt('/feeds/f1');
    await flush();
    expect(container!.textContent).toContain('Morning Watch');
    expect(container!.textContent).toContain('YT Vid');
    expect(container!.textContent).toContain('TT Vid');
  });

  it('surfaces a stale/error chip from the sources summary', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        feed: { id: 'f1', name: 'F', is_public: 0, is_owner: true },
        items: [],
        nextCursor: null,
        sources: [{ sourceId: 's1', kind: 'youtube_search', label: 'Search: x', error: 'quotaExceeded' }],
      }),
    });
    mountAt('/feeds/f1');
    await flush();
    expect(container!.textContent?.toLowerCase()).toContain('unavailable');
  });
});
