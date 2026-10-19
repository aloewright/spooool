// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { VideoPanel } from './VideoPanel';
import { ApiError } from '../create/lib/create-client';

vi.mock('./lib/studio-client', async () => {
  const { ApiError } = await import('../create/lib/create-client');
  return {
    ApiError,
    postVideoGen: vi.fn(),
    getGeneratedAsset: vi.fn(),
  };
});

import { postVideoGen, getGeneratedAsset } from './lib/studio-client';

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

async function flush(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

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
    act(() => { root!.unmount(); });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.restoreAllMocks();
});

describe('VideoPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submit button is disabled when prompt is empty', () => {
    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const btn = container!.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
  });

  it('submit button becomes enabled after typing a prompt', async () => {
    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'ocean waves');
    expect(textarea!.value).toBe('ocean waves');
    const btn = container!.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(btn!.disabled).toBe(false);
  });

  it('submits calls postVideoGen with the trimmed prompt and shows queued state', async () => {
    (postVideoGen as ReturnType<typeof vi.fn>).mockResolvedValue({ assetId: 'a_abc123', status: 'queued' });
    (getGeneratedAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'a_abc123',
      kind: 'video',
      status: 'queued',
      stream_video_id: null,
      r2_key: null,
      error_message: null,
    });

    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, '  ocean waves  ');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(12);

    expect(postVideoGen).toHaveBeenCalledWith('ocean waves');
    // Should show generating state
    expect(container!.textContent).toMatch(/Queued|Generating|minutes/i);
  });

  it('shows watch link when asset becomes ready with a stream_video_id', async () => {
    (postVideoGen as ReturnType<typeof vi.fn>).mockResolvedValue({ assetId: 'a_vid1', status: 'queued' });
    (getGeneratedAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'a_vid1',
      kind: 'video',
      status: 'ready',
      stream_video_id: 'stream_abc',
      r2_key: 'studio/video/a_vid1.mp4',
      error_message: null,
    });

    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'ocean waves');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(12);

    expect(container!.textContent).toMatch(/Watch|generated video/i);
  });

  it('shows failure state when asset status is failed', async () => {
    (postVideoGen as ReturnType<typeof vi.fn>).mockResolvedValue({ assetId: 'a_fail', status: 'queued' });
    (getGeneratedAsset as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'a_fail',
      kind: 'video',
      status: 'failed',
      stream_video_id: null,
      r2_key: null,
      error_message: 'Veo model error',
    });

    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'ocean waves');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(12);

    expect(container!.textContent).toContain('Video generation failed');
    expect(container!.textContent).toContain('Veo model error');
  });

  it('shows rate-limit copy when postVideoGen rejects with ApiError 429', async () => {
    (postVideoGen as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(429, '/api/studio/video', null, 'Too many requests'),
    );

    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'ocean waves');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(8);

    expect(container!.textContent).toContain('Rate limit: 30 studio generations per hour');
  });

  it('shows unavailable copy when postVideoGen rejects with ApiError 503', async () => {
    (postVideoGen as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(503, '/api/studio/video', null, 'Video generation is unavailable.'),
    );

    mount(<MemoryRouter><VideoPanel /></MemoryRouter>);
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    await typeIntoTextarea(textarea!, 'ocean waves');

    const form = container!.querySelector<HTMLFormElement>('form');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(8);

    expect(container!.textContent).toContain('temporarily unavailable');
  });
});
