// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

// ALO-407 / ALO-408: the `SiteFooter` unit test in App.footer.dom.test.tsx
// mounts the footer in isolation, so a regression in App.tsx that dropped the
// `<SiteFooter />` line from the shell would slip through. These tests mount
// the real `<App />` under MemoryRouter and verify the footer is rendered on
// every kind of route — public, protected, and the brand-new 404 catch-all.

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

beforeEach(() => {
  // Stub network so `useSession` and any eager page fetches resolve cleanly
  // and the test stays offline. Returning an unauthenticated session keeps
  // RequireAuth routes (e.g. /profile) on the login redirect path, which is
  // still inside the shell — the footer must render there too.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

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
  // Pages add document-level side effects (e.g. <meta robots> on NotFound).
  // Strip them between tests so assertions stay independent.
  document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
  vi.unstubAllGlobals();
});

async function mountAt(route: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
  });
  // Suspense fallback → lazy chunk resolution happens on the microtask queue.
  // A few rounds of flush make sure the page chunk has rendered before we
  // assert on its DOM, so the suite isn't flaky against `lazy()` boundaries.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function footerLinkHrefs(): string[] {
  const footer = container!.querySelector('footer.app-footer');
  expect(footer, 'app-footer must be present in the rendered shell').not.toBeNull();
  return Array.from(footer!.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

describe('App shell', () => {
  it.each([
    '/login',
    '/signup',
    '/legal/tos',
    '/legal/privacy',
    '/pricing',
  ])('renders the site footer at %s', async (route) => {
    await mountAt(route);
    expect(footerLinkHrefs()).toEqual([
      '/legal/tos',
      '/legal/privacy',
      '/pricing',
      '/legal/dmca',
    ]);
  });

  it('renders the NotFound page with the footer for an unknown route (ALO-408)', async () => {
    await mountAt('/this-route-does-not-exist');
    expect(container!.querySelector('h1')?.textContent).toBe('Page not found');
    // Footer must still be in the DOM — 404 is inside the shell, not a
    // bare error page.
    expect(footerLinkHrefs()).toHaveLength(4);
    // Crawler signal: the SPA fallback serves index.html with HTTP 200 for
    // unknown paths, so the only client-side noindex hint is the meta tag.
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots?.getAttribute('content')).toBe('noindex');
  });

  it('no longer silently redirects unknown routes to Home (ALO-408 regression)', async () => {
    await mountAt('/some/deep/typo');
    // Old behavior: <Navigate to="/"> would render the Home headings.
    const headings = Array.from(container!.querySelectorAll('h1, h2')).map((h) => h.textContent ?? '');
    expect(headings).not.toContain('Trending this week');
    expect(headings).toContain('Page not found');
  });
});
