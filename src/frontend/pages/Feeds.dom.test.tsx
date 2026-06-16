// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RouterHarness } from '../test-utils/router';
import { Feeds } from './Feeds';

import type { JSX } from "react";

// TanStack RouterProvider commits its first matched route on a transition, so
// mount inside an async act() with the flag set (was synchronous under
// the old MemoryRouter).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

async function mount(el: JSX.Element): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(<RouterHarness element={el} />);
  });
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

describe('Feeds page', () => {
  it('lists feeds returned by the API', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ feeds: [{ id: 'f1', name: 'Morning Watch', is_public: 0 }] }) });
    await mount(<Feeds />);
    await flush();
    expect(container!.textContent).toContain('Morning Watch');
  });

  it('shows an empty state when there are no feeds', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ feeds: [] }) });
    await mount(<Feeds />);
    await flush();
    expect(container!.textContent?.toLowerCase()).toContain('no feeds');
  });
});
