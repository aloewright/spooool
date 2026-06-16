// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from './test-utils/router';
import { SiteFooter } from './App';

import type { JSX } from "react";

// ALO-405: the footer used to live inside <Home>, so any route other than `/`
// rendered no ToS / Privacy / DMCA links at all. These tests pin the new
// behavior: SiteFooter is a standalone component mounted by <App>'s shell
// and renders the same four links on every route.

// TanStack RouterProvider commits its first matched route on a transition, so
// mount inside an async act() with the flag set (was synchronous under
// the old MemoryRouter).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

async function mount(element: JSX.Element): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
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
  it('renders the four legal + pricing links', async () => {
    await mount(
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
    async (route) => {
      await mount(
        <MemoryRouter initialEntries={[route]}>
          <SiteFooter />
        </MemoryRouter>,
      );
      expect(footerLinkHrefs()).toHaveLength(5);
    },
  );
});
