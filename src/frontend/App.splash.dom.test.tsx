// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { BRAND_SPLASH_TIMINGS } from './components/BrandSplash';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;
const splashTabMarker = Symbol.for('spooool.brand-splash.seen');

function mountAt(pathname: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[pathname]}>
        <App />
      </MemoryRouter>,
    );
  });
}

function unmount(): void {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  window.sessionStorage.clear();
  delete (window as unknown as Record<PropertyKey, unknown>)[splashTabMarker];
});

afterEach(() => {
  vi.useRealTimers();
  unmount();
  window.sessionStorage.clear();
  delete (window as unknown as Record<PropertyKey, unknown>)[splashTabMarker];
  vi.unstubAllGlobals();
});

describe('App brand splash integration', () => {
  it('mounts the app beneath the splash, then exposes the same shell after exit', () => {
    vi.useFakeTimers();
    mountAt('/');

    const shell = container!.querySelector<HTMLElement>('.app-shell');
    expect(shell).not.toBeNull();
    expect(container!.querySelector('button[aria-label="spooool"]')).not.toBeNull();
    expect(shell?.getAttribute('inert')).toBe('');
    expect(shell?.getAttribute('aria-hidden')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.enter);
    });
    act(() => {
      vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.hold);
    });
    act(() => {
      vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.leave);
    });

    expect(container!.querySelector('button[aria-label="spooool"]')).toBeNull();
    expect(shell?.getAttribute('inert')).toBeNull();
    expect(shell?.getAttribute('aria-hidden')).toBeNull();
    expect(window.sessionStorage.getItem('splash:seen')).toBe('1');

    unmount();
    mountAt('/');
    expect(container!.querySelector('.app-shell')).not.toBeNull();
    expect(container!.querySelector('button[aria-label="spooool"]')).toBeNull();
  });

  it.each(['/studio', '/embed/example-id'])('does not show a splash at %s', (pathname) => {
    mountAt(pathname);
    expect(container!.querySelector('button[aria-label="spooool"]')).toBeNull();
  });
});
