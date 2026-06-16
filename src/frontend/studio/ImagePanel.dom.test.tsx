// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from '../test-utils/router';
import { ImagePanel } from './ImagePanel';
import { ApiError } from '../create/lib/create-client';

// Mock the studio-client module. Re-export the real ApiError so that
// `instanceof ApiError` checks in ImagePanel work against the same class.
vi.mock('./lib/studio-client', async () => {
  const { ApiError } = await import('../create/lib/create-client');
  return { ApiError, postImage: vi.fn(), setThumbnailFromAsset: vi.fn() };
});

// Import the mocked versions after vi.mock is hoisted.
import { postImage, setThumbnailFromAsset } from './lib/studio-client';

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

/** Simulate typing into a controlled textarea the same way AIStudio.dom.test.tsx does. */
async function typeIntoTextarea(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, text);
    else (textarea as HTMLTextAreaElement).value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
  vi.restoreAllMocks();
});

const SAMPLE_IMAGE = {
  assetId: 'a1',
  r2Key: 'studio/images/a1.jpg',
  bytes: 3,
  dataUrl: 'data:image/jpeg;base64,AAAA',
};

describe('ImagePanel', () => {
  it('submit button is disabled when prompt is empty', async () => {
    await mount(
      <MemoryRouter>
        <ImagePanel videoId="v1" />
      </MemoryRouter>,
    );

    const btn = container!.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
  });

  it('submit button becomes enabled after typing a prompt', async () => {
    await mount(
      <MemoryRouter>
        <ImagePanel videoId="v1" />
      </MemoryRouter>,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();

    await typeIntoTextarea(textarea!, 'neon skyline');

    // Sanity-check: textarea must carry the typed value.
    expect(textarea!.value).toBe('neon skyline');

    const btn = container!.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(btn!.disabled).toBe(false);
  });

  it('submits calls postImage with the trimmed prompt and renders the preview img', async () => {
    (postImage as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_IMAGE);

    await mount(
      <MemoryRouter>
        <ImagePanel videoId="v1" />
      </MemoryRouter>,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, '  neon city  ');
    // Sanity-check value propagation.
    expect(textarea!.value).toBe('  neon city  ');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await flush(12);

    expect(postImage).toHaveBeenCalledWith('neon city');

    // The generated image should appear.
    const img = container!.querySelector<HTMLImageElement>('img[src^="data:image/jpeg"]');
    expect(img).not.toBeNull();

    // The "Set as video thumbnail" button should appear because videoId="v1" was passed.
    expect(container!.textContent).toContain('Set as video thumbnail');
  });

  it('clicking "Set as video thumbnail" calls setThumbnailFromAsset and flips to done', async () => {
    (postImage as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_IMAGE);
    (setThumbnailFromAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
      thumbnail_url: 'https://example.com/thumb.jpg',
    });

    await mount(
      <MemoryRouter>
        <ImagePanel videoId="v1" />
      </MemoryRouter>,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'neon city');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(12);

    // Find and click the set-thumbnail button.
    const thumbBtn = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Set as video thumbnail'));
    expect(thumbBtn).not.toBeNull();

    await act(async () => {
      thumbBtn!.click();
    });
    await flush(8);

    expect(setThumbnailFromAsset).toHaveBeenCalledWith('v1', 'a1');
    expect(container!.textContent).toContain('Thumbnail set');
  });

  it('renders rate-limit copy when postImage rejects with ApiError 429', async () => {
    (postImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(429, '/api/studio/image', null, 'Too many'),
    );

    await mount(
      <MemoryRouter>
        <ImagePanel videoId="v1" />
      </MemoryRouter>,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'neon city');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(8);

    expect(container!.textContent).toContain('Rate limit: 30 studio generations per hour');
  });

  it('renders storage-quota copy when postImage rejects with ApiError 413', async () => {
    (postImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(413, '/api/studio/image', null, 'Payload Too Large'),
    );

    await mount(
      <MemoryRouter>
        <ImagePanel videoId="v1" />
      </MemoryRouter>,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'neon city');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(8);

    expect(container!.textContent).toContain('Storage quota exceeded');
  });
});
