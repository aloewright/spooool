// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { AnimationPanel } from './AnimationPanel';

describe('AnimationPanel', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('submits animation options and links to the completed video', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'j_anim', status: 'queued', estimate: { durationSeconds: 15, estimatedCostUsd: 0.013 }, generatedAssetCount: 0 }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'j_anim', status: 'rendering', progress: 40, videoId: null, error: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'j_anim', status: 'completed', progress: 100, videoId: 'v_anim', error: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    act(() => root.render(<MemoryRouter><AnimationPanel /></MemoryRouter>));

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(textarea, 'Make a 15 second launch animation');
      else textarea.value = 'Make a 15 second launch animation';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const duration = container.querySelector('select[name="durationSeconds"]') as unknown as HTMLSelectElement;
    await act(async () => {
      duration.value = '15';
      duration.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submitBtn = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/studio/animation', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      prompt: 'Make a 15 second launch animation',
      durationSeconds: 15,
      aspectRatio: '16:9',
      style: 'clean',
      voiceover: 'none',
      useGeneratedImages: false,
    });
  });
});
