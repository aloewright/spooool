// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Regression for the "/studio breaks the site" infinite-redirect loop.
//
// /studio is handed off to the `editor` content-hub worker via the
// spooool.com/studio* zone route (spec: docs/superpowers/specs/studio-content-hub.md).
// When that zone route is NOT intercepting (local dev, or before the worker is
// deployed) the spooool SPA serves /studio itself. The old StudioHub redirect
// unconditionally re-issued window.location.replace('/studio'), which re-served
// the SPA and looped forever. StudioHub now hands off at most once (guarded by
// sessionStorage) and otherwise renders the in-app Studio fallback.

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;
let replaceSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
  window.sessionStorage.clear();
  window.sessionStorage.setItem('splash:seen', '1');
  replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
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
  const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      await yieldMacrotask();
    });
  }
}

describe('StudioHub handoff (/studio loop regression)', () => {
  it('hands off to the zone-routed hub exactly once on first visit', async () => {
    await mountAt('/studio');
    // One handoff attempt, never a loop.
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy.mock.calls[0][0]).toBe('/studio');
    // Guard marker is set so the post-reload mount knows it already tried.
    expect(window.sessionStorage.getItem('studio:handoff')).toBe('1');
  });

  it('does NOT redirect again when the reload lands back on the SPA', async () => {
    // Simulate the state right after the one-shot handoff reload when the zone
    // route did not intercept (the marker survives the full page reload).
    window.sessionStorage.setItem('studio:handoff', '1');
    await mountAt('/studio');
    // The loop is broken: no further redirect.
    expect(replaceSpy).not.toHaveBeenCalled();
    // Marker cleared so a later, intentional visit can attempt the handoff again.
    expect(window.sessionStorage.getItem('studio:handoff')).toBeNull();
    // Site is intact (shell still rendered), not a blank reload loop.
    expect(container!.querySelector('footer.app-footer')).not.toBeNull();
  });

  it('degrades to the in-app Studio (no redirect) when sessionStorage throws', async () => {
    // Storage disabled/partitioned (private mode, sandboxed iframe): reading
    // the guard key throws. Without a guard we must not attempt the handoff, or
    // it would loop unguarded — so render the fallback instead.
    const realGetItem = window.sessionStorage.getItem.bind(window.sessionStorage);
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation((key: string) => {
      if (key === 'studio:handoff') throw new Error('storage disabled');
      return realGetItem(key);
    });
    await mountAt('/studio');
    // No redirect attempted → no infinite loop.
    expect(replaceSpy).not.toHaveBeenCalled();
    // Shell still rendered (fallback Studio mounts inside it), not a blank page.
    expect(container!.querySelector('footer.app-footer')).not.toBeNull();
  });
});
