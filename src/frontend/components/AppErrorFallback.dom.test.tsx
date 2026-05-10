// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { AppErrorFallback } from './AppErrorFallback';

// ALO-281: real-DOM render tests for the render-time crash fallback. The
// pragma above flips this file (and only this file) into happy-dom so React
// 18's ErrorBoundary commit phase actually catches the throw — every other
// test in the suite stays on the default node environment.

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

function Boom(): JSX.Element {
  throw new Error('render-time crash');
}

describe('AppErrorFallback', () => {
  it('renders Strand-themed fallback copy + Reload action', () => {
    mount(<AppErrorFallback />);
    expect(container!.textContent).toContain('Something went wrong');
    const button = container!.querySelector('button');
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain('Reload');
    // Fallback is exposed as an alert region for AT.
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();
    // Uses Strand classes, not bare unstyled markup.
    expect(button!.className).toMatch(/\bbtn\b/);
    expect(container!.querySelector('.card')).not.toBeNull();
  });

  it('invokes onReload when the button is clicked', () => {
    const onReload = vi.fn();
    mount(<AppErrorFallback onReload={onReload} />);
    const button = container!.querySelector('button')!;
    act(() => {
      button.click();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('Sentry.ErrorBoundary + AppErrorFallback', () => {
  it('renders the fallback when a child throws during render', () => {
    // React logs caught errors via console.error; suppress so output stays
    // clean. The boundary itself is what we're validating.
    const originalError = console.error;
    console.error = () => undefined;
    try {
      mount(
        <Sentry.ErrorBoundary fallback={<AppErrorFallback />}>
          <Boom />
        </Sentry.ErrorBoundary>,
      );
      expect(container!.textContent).toContain('Something went wrong');
      expect(container!.querySelector('button')!.textContent).toContain('Reload');
      // Boom should have been replaced — its render output is gone.
      expect(container!.textContent).not.toContain('render-time crash');
    } finally {
      console.error = originalError;
    }
  });
});
