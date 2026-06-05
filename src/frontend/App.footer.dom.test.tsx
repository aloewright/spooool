// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { SiteFooter } from './App';

// ALO-405: the footer used to live inside <Home>, so any route other than `/`
// rendered no ToS / Privacy / DMCA links at all. These tests pin the new
// behavior: SiteFooter is a standalone component mounted by <App>'s shell
// and renders the same four links on every route.

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(element: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => {
    root!.render(element);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

function footerLinkHrefs(): string[] {
  const footer = container!.querySelector('footer.app-footer');
  expect(footer).not.toBeNull();
  return Array.from(footer!.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

describe('SiteFooter', () => {
  it('renders the four legal + pricing links', () => {
    mount(
      <MemoryRouter initialEntries={['/login']}>
        <SiteFooter />
      </MemoryRouter>,
    );
    const hrefs = footerLinkHrefs();
    expect(hrefs).toEqual([
      '/legal/tos',
      '/legal/privacy',
      '/pricing',
      '/legal/dmca',
      '/status',
    ]);
  });

  it.each(['/watch/abc', '/profile', '/channel/alice', '/settings/account'])(
    'renders the same footer on route %s',
    (route) => {
      mount(
        <MemoryRouter initialEntries={[route]}>
          <SiteFooter />
        </MemoryRouter>,
      );
      expect(footerLinkHrefs()).toHaveLength(5);
    },
  );
});
