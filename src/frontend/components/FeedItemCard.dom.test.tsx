// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { FeedItemCard } from './FeedItemCard';
import type { FeedItem } from '../lib/feeds-client';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(el: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
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
  it('renders a spooool item as an internal /watch link', () => {
    mount(<FeedItemCard item={item({ source: 'spooool', id: 'spv1', url: '/watch/spv1' })} />);
    const a = container!.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('/watch/spv1');
  });

  it('renders a youtube item with a play button (embed component)', () => {
    mount(<FeedItemCard item={item({ source: 'youtube', embed: { kind: 'youtube', videoId: 'abc' } })} />);
    expect(container!.querySelector('button[aria-label^="Play"]')).not.toBeNull();
  });

  it('renders a tiktok item as an external link that opens in a new tab', () => {
    mount(<FeedItemCard item={item({ source: 'tiktok', url: 'https://www.tiktok.com/@u/video/7' })} />);
    const a = container!.querySelector('a[target="_blank"]');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('rel')).toContain('noopener');
    expect(a!.getAttribute('href')).toBe('https://www.tiktok.com/@u/video/7');
  });
});
