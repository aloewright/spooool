// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from '../test-utils/router';
import { StudioRoot } from './index';

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

async function flush(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

/**
 * Build a text/event-stream Response whose body is a ReadableStream that
 * emits AG-UI events for a single assistant reply.
 *
 * readStreamLines (in @tanstack/ai-client) splits the decoded bytes on "\n"
 * and skips blank lines, then expects lines starting with "data: " to be
 * parsed via parseSseDataLine. We emit each event as "data: <json>\n\n".
 */
function sseResponse(text: string): Response {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const body =
    ev({ type: 'RUN_STARTED', runId: 'r1', threadId: 't1' }) +
    ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }) +
    ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: text }) +
    ev({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }) +
    ev({ type: 'RUN_FINISHED', runId: 'r1', threadId: 't1', model: 'test', timestamp: Date.now(), finishReason: 'stop' });

  // Encode as a ReadableStream so response.body.getReader() works in happy-dom.
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

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

describe('AIStudio', () => {
  it('renders empty state hint before any messages', async () => {
    await mount(
      <MemoryRouter>
        <StudioRoot />
      </MemoryRouter>,
    );

    expect(container!.textContent).toContain('Animated video');
    expect(container!.textContent).toContain('Ask for video ideas');
  });

  it('sends a user message and renders the streaming assistant reply', async () => {
    const REPLY = 'Here are some great video ideas!';

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse(REPLY));

    await mount(
      <MemoryRouter>
        <StudioRoot />
      </MemoryRouter>,
    );

    const USER_MSG = 'Give me video ideas';

    // Set textarea value and fire React's synthetic onChange.
    const textareas = container!.querySelectorAll('textarea');
    const chatTextarea = textareas[1] as HTMLTextAreaElement;
    expect(chatTextarea).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(chatTextarea, USER_MSG);
      else chatTextarea.value = USER_MSG;
      chatTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(chatTextarea.value).toBe(USER_MSG);

    const form = chatTextarea.closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Drain the async SSE stream through enough microtask / render cycles.
    await flush(12);

    // The user's message should appear.
    expect(container!.textContent).toContain(USER_MSG);
    // The assistant reply should appear.
    expect(container!.textContent).toContain(REPLY);
  });
});
