// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { Feeds } from './Feeds';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(el: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
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
    mount(<Feeds />);
    await flush();
    expect(container!.textContent).toContain('Morning Watch');
  });

  it('shows an empty state when there are no feeds', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ feeds: [] }) });
    mount(<Feeds />);
    await flush();
    expect(container!.textContent?.toLowerCase()).toContain('no feeds');
  });
});
