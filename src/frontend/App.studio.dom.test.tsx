// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RealAppAt } from './test-utils/router';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// /studio behavior (sub-project #4, PR-1).
//
// /studio used to be a one-shot handoff (StudioHub) to a separately-deployed
// content-hub worker, with a sessionStorage guard against an infinite reload
// loop. That handoff is GONE: /studio now mounts the ported content hub in-app
// (src/frontend/content-hub/) behind RequireAuth. These tests preserve the
// spirit of the old loop regression — "/studio must never break the site or
// loop" — adapted to the new gated route:
//   1. Signed out → redirect to /login (rendered inside the shell), no loop.
//   2. Signed in  → the content-hub home mounts (QueryClient + studio CSS),
//      no redirect, no loop.
//
// The auth state is driven by mocking `useSession` rather than better-auth's
// async session fetch: RequireAuth's gate (and thus the route under test) is
// what we're verifying, and the mock makes the signed-in/out states
// deterministic without depending on the nanostore fetch lifecycle.
type MockSession = { data: unknown; isPending: boolean };
let mockSession: MockSession = { data: null, isPending: false };

vi.mock('./lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/auth-client')>();
  return { ...actual, useSession: () => mockSession };
});

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;
let replaceSpy: ReturnType<typeof vi.spyOn>;
let assignSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The hub's /api/v1/* list calls return empty collections so the home
  // renders its empty state without throwing.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], retention_days: 30 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  window.sessionStorage.clear();
  window.sessionStorage.setItem('splash:seen', '1');
  replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  mockSession = { data: null, isPending: false };
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

async function mountAt(route: string, settle?: () => boolean): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(<RealAppAt route={route} />);
  });
  // Suspense fallback → lazy chunk → component render takes several event-loop
  // turns, and /studio nests two lazy boundaries (StudioLayout → ContentHubHome).
  // Poll until `settle()` is satisfied (or the cap is hit) rather than guessing
  // a fixed flush count — robust against suite-load slowdowns. Mirrors the
  // content-based polling in App.shell.dom.test.tsx.
  const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await yieldMacrotask();
    });
    if (settle?.()) return;
  }
}

describe('/studio content hub (no-loop regression)', () => {
  it('redirects to /login when signed out — never loops or blanks the site', async () => {
    mockSession = { data: null, isPending: false };
    await mountAt('/studio');
    // RequireAuth → <Navigate to="/login">. The site is intact (shell still
    // renders) rather than reloading itself or going blank.
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(container!.querySelector('footer.app-footer')).not.toBeNull();
    // Something rendered (the login redirect target), not a blank page.
    expect((container!.textContent ?? '').trim()).not.toBe('');
  });

  it('mounts the content-hub home when signed in (no redirect, no loop)', async () => {
    mockSession = {
      data: { user: { id: 'u1', email: 'writer@example.com', name: 'Writer' } },
      isPending: false,
    };
    await mountAt('/studio', () =>
      Array.from(container?.querySelectorAll('a') ?? []).some(
        (a) => a.getAttribute('href') === '/studio/compose',
      ),
    );
    // No window-level navigation occurred — the hub rendered in-app.
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    // The hub home renders the create-actions ("New book"/"New blog"/"New
    // script"), each linking to the future /studio/compose* paths.
    const hrefs = Array.from(container!.querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? '',
    );
    expect(hrefs).toContain('/studio/compose');
    expect(hrefs).toContain('/studio/compose-blog');
    expect(hrefs).toContain('/studio/compose-script');
  });
});
