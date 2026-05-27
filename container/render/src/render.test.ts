import { describe, expect, it, vi } from 'vitest';
import { renderJob, type RemotionRenderer } from './render';

describe('renderJob', () => {
  it('downloads each take into the bundle\'s public/{jobId}/ dir and calls the renderer', async () => {
    const downloaded: string[] = [];
    const renderer: RemotionRenderer = {
      bundle: vi.fn(async () => '/bundle'),
      selectComposition: vi.fn(async () => ({
        id: 'spooool-video',
        durationInFrames: 300,
        fps: 30,
        width: 1920,
        height: 1080,
      })),
      renderMedia: vi.fn(async (opts) => {
        opts.onProgress?.({ progress: 0.5 });
        opts.onProgress?.({ progress: 1 });
      }),
    };
    const downloadTake = vi.fn(async (key: string, dest: string) => {
      downloaded.push(`${key}->${dest}`);
    });
    const onProgressCalls: number[] = [];

    const result = await renderJob(
      {
        jobId: 'j_1',
        takeKeys: ['recorder/raw/u/s/take_001.webm', 'recorder/raw/u/s/take_002.webm'],
        compositionProps: { title: 'hello', sceneOrder: ['main'] },
        onProgress: (p) => onProgressCalls.push(p),
      },
      {
        renderer,
        downloadTake,
        tmpDir: '/tmp',
        publicDir: '/bundle/public',
        remotionEntry: '/remotion/index.ts',
      },
    );

    expect(result.outputPath).toMatch(/j_1\.mp4$/);
    expect(renderer.bundle).toHaveBeenCalledTimes(1);
    expect(renderer.selectComposition).toHaveBeenCalledWith(expect.objectContaining({
      serveUrl: '/bundle',
      id: 'spooool-video',
      inputProps: expect.objectContaining({
        takes: ['j_1/take_001.webm', 'j_1/take_002.webm'],
      }),
    }));
    expect(renderer.renderMedia).toHaveBeenCalledWith(expect.objectContaining({
      inputProps: expect.objectContaining({
        takes: ['j_1/take_001.webm', 'j_1/take_002.webm'],
      }),
    }));
    expect(renderer.renderMedia).toHaveBeenCalledTimes(1);
    expect(downloaded).toEqual([
      'recorder/raw/u/s/take_001.webm->/bundle/public/j_1/take_001.webm',
      'recorder/raw/u/s/take_002.webm->/bundle/public/j_1/take_002.webm',
    ]);
    expect(onProgressCalls).toEqual([50, 100]);
  });

  it('reuses the bundle across multiple jobs (cached)', async () => {
    const renderer: RemotionRenderer = {
      bundle: vi.fn(async () => '/bundle'),
      selectComposition: vi.fn(async () => ({
        id: 'spooool-video', durationInFrames: 300, fps: 30, width: 1920, height: 1080,
      })),
      renderMedia: vi.fn(async () => {}),
    };
    const downloadTake = vi.fn(async () => {});
    const deps = {
      renderer,
      downloadTake,
      tmpDir: '/tmp',
      publicDir: '/bundle/public',
      remotionEntry: '/remotion/index.ts',
    };

    await renderJob({ jobId: 'j_1', takeKeys: ['k'], compositionProps: {}, onProgress: () => {} }, deps);
    await renderJob({ jobId: 'j_2', takeKeys: ['k'], compositionProps: {}, onProgress: () => {} }, deps);
    expect(renderer.bundle).toHaveBeenCalledTimes(1);
  });

  it('uses a separate bundle for each distinct renderer instance', async () => {
    const makeRenderer = () => ({
      bundle: vi.fn(async () => '/bundle'),
      selectComposition: vi.fn(async () => ({
        id: 'spooool-video',
        durationInFrames: 300,
        fps: 30,
        width: 1920,
        height: 1080,
      })),
      renderMedia: vi.fn(async () => {}),
    });
    const r1 = makeRenderer();
    const r2 = makeRenderer();
    const base = {
      downloadTake: vi.fn(async () => {}),
      tmpDir: '/tmp',
      publicDir: '/pub',
      remotionEntry: '/r/index.ts',
    };

    await renderJob(
      { jobId: 'j_a', takeKeys: [], compositionProps: {}, onProgress: () => {} },
      { ...base, renderer: r1 },
    );
    await renderJob(
      { jobId: 'j_b', takeKeys: [], compositionProps: {}, onProgress: () => {} },
      { ...base, renderer: r2 },
    );

    expect(r1.bundle).toHaveBeenCalledTimes(1);
    expect(r2.bundle).toHaveBeenCalledTimes(1);
  });
});
