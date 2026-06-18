// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RealAppAt } from './test-utils/router';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Project workspace shell (sub-project #4, PR-3).
//
// PR-2 left the compose wizards redirecting to /studio/$id, which 404'd. PR-3
// registers the project workspace so that path resolves. These tests lock in
// the route registration:
//   1. Bare /studio/$projectId redirects to /studio/$projectId/canvas (the
//      index child <Navigate>), mirroring the studio source's beforeLoad.
//   2. /studio/$projectId/outline mounts the outline builder.
// Both run signed-in (RequireAuth gates the /studio layout). The auth state is
// mocked via useSession exactly as App.studio.dom.test.tsx does.
type MockSession = { data: unknown; isPending: boolean };
let mockSession: MockSession = { data: null, isPending: false };

vi.mock('./lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/auth-client')>();
  return { ...actual, useSession: () => mockSession };
});

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;
let assignSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // /api/v1/* reads return empty/placeholder shapes so the canvas/outline
  // render their empty states without throwing.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/outline')) {
        return new Response(JSON.stringify({ outline: null, chapters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/session')) {
        return new Response(JSON.stringify({ user: { id: 'u1', email: 'w@example.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // getProject and everything else: a minimal project.
      return new Response(
        JSON.stringify({ id: 'p1', title: 'My Book', type: 'fiction', status: 'draft' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  window.sessionStorage.clear();
  window.sessionStorage.setItem('splash:seen', '1');
  assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  mockSession = {
    data: { user: { id: 'u1', email: 'w@example.com', name: 'Writer' } },
    isPending: false,
  };
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
  const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));
  // Generous poll budget: under the full suite these dom tests run alongside
  // many other files across worker threads, and CPU contention can slow the
  // lazy /studio chunk + react-query settle past a short window. 300 macrotasks
  // (returning as soon as `settle` is true) keeps the fast path fast while
  // staying robust under load.
  for (let i = 0; i < 300; i++) {
    await act(async () => {
      await yieldMacrotask();
    });
    if (settle?.()) return;
  }
}

describe('/studio/$projectId workspace (PR-3)', () => {
  it('redirects bare /studio/$projectId to the canvas', async () => {
    await mountAt('/studio/p1', () =>
      Boolean(container?.querySelector('main')) &&
      (container?.textContent ?? '').includes('No chapters yet'),
    );
    // The canvas renders its empty state (no chapters), and no window-level
    // navigation/loop occurred — the redirect stayed in-app.
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('No chapters yet');
    // The empty state links the author to the outline.
    const hrefs = Array.from(container!.querySelectorAll('a')).map(
      (a) => a.getAttribute('href') ?? '',
    );
    expect(hrefs).toContain('/studio/p1/outline');
  });

  it('mounts the outline builder at /studio/$projectId/outline', async () => {
    await mountAt('/studio/p1/outline', () =>
      (container?.textContent ?? '').includes('Pick a framework'),
    );
    expect(assignSpy).not.toHaveBeenCalled();
    // With no chapters, the outline shows the framework wizard.
    expect(container!.textContent ?? '').toContain('Pick a framework');
  });
});
