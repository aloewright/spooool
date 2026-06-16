// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RouterHarness } from '../test-utils/router';
import { FeedItemCard } from './FeedItemCard';
import type { FeedItem } from '../lib/feeds-client';

import type { JSX } from "react";

// TanStack RouterProvider commits its first matched route on a transition
// (microtask), so the harness must be mounted inside an async act() and the
// flag set, or the container is empty on the next line. (Was synchronous
// under the old MemoryRouter.)
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

async function mount(el: JSX.Element): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(<RouterHarness element={el} />);
  });
}

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

function item(over: Partial<FeedItem>): FeedItem {
  return {
    source: 'youtube', id: 'x', title: 'T', author: 'A', thumbnailUrl: 'https://i/x.jpg',
    publishedAt: Date.now(), durationSec: null, url: 'https://example.com/x', ...over,
  };
}

describe('FeedItemCard', () => {
  it('renders a spooool item as an internal /watch link', async () => {
    await mount(<FeedItemCard item={item({ source: 'spooool', id: 'spv1', url: '/watch/spv1' })} />);
    const a = container!.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('/watch/spv1');
  });

  it('renders a youtube item with a play button (embed component)', async () => {
    await mount(<FeedItemCard item={item({ source: 'youtube', embed: { kind: 'youtube', videoId: 'abc' } })} />);
    expect(container!.querySelector('button[aria-label^="Play"]')).not.toBeNull();
  });

  it('renders a non-youtube item with an inline play button (Cobalt), not a link-out', async () => {
    await mount(<FeedItemCard item={item({ source: 'tiktok', url: 'https://www.tiktok.com/@u/video/7' })} />);
    // Non-spooool/non-youtube items play inline via Cobalt: a Play button is
    // shown and there is no external link-out in the default (pre-resolve) state.
    expect(container!.querySelector('button.feed-card__play')).not.toBeNull();
    expect(container!.querySelector('a[target="_blank"]')).toBeNull();
  });
});
