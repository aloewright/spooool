// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { BrandSplash, BRAND_SPLASH_TIMINGS, useBrandSplash } from './BrandSplash';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;
const splashTabMarker = Symbol.for('spooool.brand-splash.seen');

function mount(element: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(element));
}

function splashButton(): HTMLButtonElement {
  return container!.querySelector('button[aria-label="spooool"]')!;
}

function expectAttribute(element: Element, name: string, value: string): void {
  expect(element.getAttribute(name)).toBe(value);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  delete (window as unknown as Record<PropertyKey, unknown>)[splashTabMarker];
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe('BrandSplash', () => {
  it('renders an accessible wordmark with stagger indexes for its four os', () => {
    mount(<BrandSplash onDone={vi.fn()} />);
    const button = splashButton();
    expectAttribute(button, 'type', 'button');
    expectAttribute(button, 'aria-label', 'spooool');
    expect(button.hasAttribute('autofocus')).toBe(false);
    expect(button.querySelector('.splash__word')).not.toBeNull();
    const letters = Array.from(button.querySelectorAll<HTMLSpanElement>('.splash__letter'));
    expect(letters.map((letter) => letter.textContent)).toEqual([
      's',
      'p',
      'o',
      'o',
      'o',
      'o',
      'l',
    ]);
    expect(letters.every((letter) => letter.getAttribute('aria-hidden') === 'true')).toBe(true);
    const os = letters.filter((letter) => letter.textContent === 'o');
    expect(os.every((letter) => letter.classList.contains('splash__letter--o'))).toBe(true);
    expect(os.map((letter) => letter.style.getPropertyValue('--splash-o-index'))).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(button.style.getPropertyValue('--splash-enter-duration')).toBe('240ms');
    expect(button.style.getPropertyValue('--splash-pulse-duration')).toBe('180ms');
    expect(button.style.getPropertyValue('--splash-pulse-stagger')).toBe('90ms');
    expect(BRAND_SPLASH_TIMINGS).toMatchObject({
      enter: 240,
      pulse: 180,
      pulseStagger: 90,
      hold: 1110,
      leave: 280,
    });
  });

  it('moves through entering, holding, and leaving before completing', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    mount(<BrandSplash onDone={onDone} />);
    expectAttribute(splashButton(), 'data-phase', 'entering');
    act(() => vi.advanceTimersByTime(240));
    expectAttribute(splashButton(), 'data-phase', 'holding');
    act(() => vi.advanceTimersByTime(1110));
    expectAttribute(splashButton(), 'data-phase', 'leaving');
    act(() => vi.advanceTimersByTime(280));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['click', (button: HTMLButtonElement) => button.click()],
    [
      'Enter',
      (button: HTMLButtonElement) =>
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    ],
    [
      'Space',
      (button: HTMLButtonElement) =>
        button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    ],
    [
      'Escape',
      (button: HTMLButtonElement) =>
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    ],
  ])('skips with %s', (_name, trigger) => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    mount(<BrandSplash onDone={onDone} />);
    act(() => trigger(splashButton()));
    expectAttribute(splashButton(), 'data-phase', 'leaving');
    act(() => vi.advanceTimersByTime(280));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('lets Escape dismiss the overlay before it receives focus', () => {
    vi.useFakeTimers();
    mount(<BrandSplash onDone={vi.fn()} />);

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expectAttribute(splashButton(), 'data-phase', 'leaving');
  });

  it('uses the reduced-motion schedule and only completes once for duplicate skips', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const onDone = vi.fn();
    mount(<BrandSplash onDone={onDone} />);
    expectAttribute(splashButton(), 'data-reduced-motion', 'true');
    expectAttribute(splashButton(), 'data-phase', 'holding');
    act(() => vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.reducedHold));
    expectAttribute(splashButton(), 'data-phase', 'leaving');
    act(() => {
      splashButton().click();
      splashButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.reducedLeave);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

function HookHarness({
  pathname,
  onChange,
}: {
  pathname: string;
  onChange: (show: boolean, dismiss: () => void) => void;
}): JSX.Element {
  const state = useBrandSplash(pathname);
  useEffect(() => onChange(state.show, state.dismiss), [onChange, state.dismiss, state.show]);
  return <output>{String(state.show)}</output>;
}

function RenderHookHarness({
  pathname,
  onRender,
}: {
  pathname: string;
  onRender: (show: boolean) => void;
}): JSX.Element {
  const state = useBrandSplash(pathname);
  onRender(state.show);
  return <output>{String(state.show)}</output>;
}

describe('useBrandSplash', () => {
  it('keeps an unseen home visit visible in StrictMode and marks it seen', () => {
    mount(
      <React.StrictMode>
        <HookHarness pathname="/" onChange={vi.fn()} />
      </React.StrictMode>,
    );
    expect(container!.textContent).toBe('true');
    expect(window.sessionStorage.getItem('splash:seen')).toBe('1');
  });

  it('only shows once on home and marks it seen', () => {
    const first = vi.fn();
    mount(<HookHarness pathname="/" onChange={first} />);
    expect(first).toHaveBeenLastCalledWith(true, expect.any(Function));
    expect(window.sessionStorage.getItem('splash:seen')).toBe('1');

    act(() => root!.unmount());
    root = null;
    container!.remove();
    mount(<HookHarness pathname="/" onChange={vi.fn()} />);
    expect(container!.textContent).toBe('false');
  });

  it('never shows off the home route and dismisses even when storage throws', () => {
    mount(<HookHarness pathname="/feed" onChange={vi.fn()} />);
    expect(container!.textContent).toBe('false');
    act(() => root!.unmount());
    root = null;
    container!.remove();

    const getItem = vi.fn(() => {
      throw new Error('blocked');
    });
    const setItem = vi.fn(() => {
      throw new Error('blocked');
    });
    const sessionStorage = vi
      .spyOn(window, 'sessionStorage', 'get')
      .mockReturnValue({ getItem, setItem } as unknown as Storage);
    const state = vi.fn();
    mount(<HookHarness pathname="/" onChange={state} />);
    expect(container!.textContent).toBe('true');
    act(() => state.mock.lastCall![1]());
    expect(container!.textContent).toBe('false');
    sessionStorage.mockRestore();
  });

  it('stays hidden after remounting when session storage is denied', () => {
    const getItem = vi.fn(() => {
      throw new Error('blocked');
    });
    const setItem = vi.fn(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue({
      getItem,
      setItem,
    } as unknown as Storage);
    const first = vi.fn();
    mount(<HookHarness pathname="/" onChange={first} />);
    expect(container!.textContent).toBe('true');
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
    act(() => first.mock.lastCall![1]());
    expect(container!.textContent).toBe('false');

    act(() => root!.unmount());
    root = null;
    container!.remove();
    mount(<HookHarness pathname="/" onChange={vi.fn()} />);
    expect(container!.textContent).toBe('false');
  });

  it('claims a first home visit after same-mount navigation and never re-shows it', () => {
    mount(<HookHarness pathname="/feed" onChange={vi.fn()} />);
    expect(container!.textContent).toBe('false');
    expect(window.sessionStorage.getItem('splash:seen')).toBeNull();

    act(() => root!.render(<HookHarness pathname="/" onChange={vi.fn()} />));
    expect(container!.textContent).toBe('true');
    expect(window.sessionStorage.getItem('splash:seen')).toBe('1');

    act(() => root!.render(<HookHarness pathname="/feed" onChange={vi.fn()} />));
    expect(container!.textContent).toBe('false');
    act(() => root!.render(<HookHarness pathname="/" onChange={vi.fn()} />));
    expect(container!.textContent).toBe('false');
  });

  it('covers the first home navigation on its initial render', () => {
    const renderedStates: boolean[] = [];
    const onRender = (show: boolean) => renderedStates.push(show);
    mount(<RenderHookHarness pathname="/feed" onRender={onRender} />);
    expect(renderedStates).toEqual([false]);

    const beforeHomeRender = renderedStates.length;
    act(() => root!.render(<RenderHookHarness pathname="/" onRender={onRender} />));

    expect(renderedStates.slice(beforeHomeRender)).not.toContain(false);
    expect(container!.textContent).toBe('true');
  });

  it('is safe to render without a browser window', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(() => renderToString(<HookHarness pathname="/" onChange={vi.fn()} />)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
