// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from '../test-utils/router';
import { AnimationPanel } from './AnimationPanel';

vi.mock('./lib/studio-client', async () => {
  const { ApiError } = await import('../create/lib/create-client');
  return { ApiError, postAnimation: vi.fn(), getRenderJob: vi.fn() };
});

import { getRenderJob, postAnimation } from './lib/studio-client';

// TanStack RouterProvider commits its first matched route on a transition, so
// mount inside an async act() with the flag set (was synchronous under
// the old MemoryRouter).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter><AnimationPanel /></MemoryRouter>);
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
    else textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm(): Promise<void> {
  const form = container!.querySelector<HTMLFormElement>('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('AnimationPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(postAnimation).mockReset();
    vi.mocked(getRenderJob).mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('submits animation options and polls through rendering to the watch link', async () => {
    (postAnimation as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: 'j_anim',
      status: 'queued',
      estimate: { durationSeconds: 15, estimatedCostUsd: 0.013 },
      generatedAssetCount: 0,
    });
    (getRenderJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'j_anim', status: 'rendering', progress: 40, videoId: null, error: null })
      .mockResolvedValueOnce({ id: 'j_anim', status: 'completed', progress: 100, videoId: 'v_anim', error: null });

    await mount();

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!;
    await typeIntoTextarea(textarea, 'Make a 15 second launch animation');
    const duration = container!.querySelector('select[name="durationSeconds"]') as unknown as HTMLSelectElement;
    await act(async () => {
      duration.value = '15';
      duration.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await submitForm();
    await flush(12);

    expect(postAnimation).toHaveBeenCalledWith({
      prompt: 'Make a 15 second launch animation',
      durationSeconds: 15,
      aspectRatio: '16:9',
      style: 'clean',
      voiceover: 'none',
      useGeneratedImages: false,
    });
    expect(container!.textContent).toContain('Estimated cost: $0.013');
    expect(container!.textContent).toContain('Job: j_anim');
    expect(container!.textContent).toContain('rendering (40%)');
    expect(getRenderJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await flush(12);

    expect(getRenderJob).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain('completed (100%)');
    const watchLink = container!.querySelector<HTMLAnchorElement>('a[href="/watch/v_anim"]');
    expect(watchLink).not.toBeNull();
    expect(watchLink!.textContent).toContain('Watch your animation');
  });

  it('stops polling and surfaces an error when the render job fails', async () => {
    (postAnimation as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: 'j_fail',
      status: 'queued',
      estimate: { durationSeconds: 30, estimatedCostUsd: 0.025 },
      generatedAssetCount: 0,
    });
    (getRenderJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'j_fail',
      status: 'failed',
      progress: 0,
      videoId: null,
      error: 'Encoder crashed',
    });

    await mount();

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!;
    await typeIntoTextarea(textarea, 'Broken render');
    await submitForm();
    await flush(12);

    expect(container!.textContent).toContain('Encoder crashed');
    expect(container!.querySelector('a[href^="/watch/"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await flush(4);

    expect(getRenderJob).toHaveBeenCalledTimes(1);
  });
});
