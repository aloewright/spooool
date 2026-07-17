// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { BrandSplash, BRAND_SPLASH_TIMINGS, useBrandSplash } from './BrandSplash';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

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
  window.sessionStorage.clear();
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
    expect(os.map((letter) => letter.style.getPropertyValue('--splash-o-index'))).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(button.style.getPropertyValue('--splash-enter-duration')).toBe(
      `${BRAND_SPLASH_TIMINGS.enter}ms`,
    );
  });

  it('moves through entering, holding, and leaving before completing', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    mount(<BrandSplash onDone={onDone} />);
    expectAttribute(splashButton(), 'data-phase', 'entering');
    act(() => vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.enter));
    expectAttribute(splashButton(), 'data-phase', 'holding');
    act(() => vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.hold));
    expectAttribute(splashButton(), 'data-phase', 'leaving');
    act(() => vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.leave));
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
    act(() => vi.advanceTimersByTime(BRAND_SPLASH_TIMINGS.leave));
    expect(onDone).toHaveBeenCalledTimes(1);
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

describe('useBrandSplash', () => {
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

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const state = vi.fn();
    mount(<HookHarness pathname="/" onChange={state} />);
    expect(container!.textContent).toBe('true');
    act(() => state.mock.lastCall![1]());
    expect(container!.textContent).toBe('false');
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
