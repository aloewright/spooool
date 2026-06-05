// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { YouTubeEmbed } from './YouTubeEmbed';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(el: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(el));
}

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

describe('YouTubeEmbed', () => {
  it('shows a thumbnail button first and no iframe', () => {
    mount(<YouTubeEmbed videoId="abc123" title="Cool" thumbnailUrl="https://i/x.jpg" />);
    expect(container!.querySelector('iframe')).toBeNull();
    expect(container!.querySelector('button')).not.toBeNull();
  });

  it('loads the nocookie iframe after a click', () => {
    mount(<YouTubeEmbed videoId="abc123" title="Cool" thumbnailUrl="https://i/x.jpg" />);
    act(() => {
      container!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const iframe = container!.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('src')).toContain('https://www.youtube-nocookie.com/embed/abc123');
  });
});
