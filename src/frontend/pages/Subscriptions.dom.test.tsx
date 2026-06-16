// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RouterHarness } from '../test-utils/router';
import { Subscriptions } from './Subscriptions';

import type { JSX } from "react";

// TanStack RouterProvider commits its first matched route on a transition, so
// mount inside an async act() with the flag set (was synchronous under
// the old MemoryRouter).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

async function mount(element: JSX.Element): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const SAMPLE_ITEM = {
  video_id: 'v_abc',
  channel_user_id: 'u_x',
  added_at: new Date(Date.now() - 60_000).toISOString(),
  seen_at: null,
  title: 'A wonderful new video',
  thumbnail_url: 'https://cdn.example.com/t.jpg',
  video_created_at: new Date().toISOString(),
  channel_name: 'Cool Creator',
  channel_username: 'cool',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
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
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Subscriptions page', () => {
  it('renders inbox items from /api/users/me/inbox and POSTs /seen', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/users/me/inbox?')) {
        return new Response(
          JSON.stringify({ items: [SAMPLE_ITEM], page: 1, limit: 50, unseenOnly: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/users/me/inbox/seen' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await mount(<RouterHarness element={<Subscriptions />} />);
    await flush();

    expect(container!.textContent).toContain('A wonderful new video');
    expect(container!.textContent).toContain('Cool Creator');
    const watchLink = container!.querySelector<HTMLAnchorElement>('a[href="/watch/v_abc"]');
    expect(watchLink).not.toBeNull();
    const channelLink = container!.querySelector<HTMLAnchorElement>('a[href="/channel/cool"]');
    expect(channelLink).not.toBeNull();

    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.startsWith('/api/users/me/inbox?'))).toBe(true);
    expect(calls).toContain('/api/users/me/inbox/seen');
  });

  it('renders the empty state when there are no inbox items', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ items: [], page: 1, limit: 50, unseenOnly: false }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    await mount(<RouterHarness element={<Subscriptions />} />);
    await flush();

    expect(container!.textContent).toContain("You're not subscribed to any channels yet");
    const browseLink = container!.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(browseLink).not.toBeNull();
  });

  it('surfaces an error message when the inbox fetch fails', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

    await mount(<RouterHarness element={<Subscriptions />} />);
    await flush();

    expect(container!.textContent).toContain('Failed to load subscriptions');
  });
});
