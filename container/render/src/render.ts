// Bridge between the queued render job and Remotion's renderer. Pure of side
// effects so unit tests can inject the renderer + a fake take-downloader.
// The real renderer (bundle + selectComposition + renderMedia) is plugged
// in by the production entrypoint in server.ts; tests pass a stub.
//
// Takes are downloaded into the bundle's public/ dir under the jobId so the
// Remotion composition can resolve them via staticFile('jobId/takeId.webm').

import path from 'node:path';

export interface RemotionRenderer {
  bundle: (entryPoint: string) => Promise<string>;
  selectComposition: (args: {
    serveUrl: string;
    id: string;
    inputProps: Record<string, unknown>;
  }) => Promise<{
    id: string;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
  }>;
  renderMedia: (args: {
    composition: { id: string; durationInFrames: number; fps: number; width: number; height: number };
    serveUrl: string;
    codec: 'h264';
    outputLocation: string;
    inputProps: Record<string, unknown>;
    onProgress?: (p: { progress: number }) => void;
  }) => Promise<void>;
}

export interface RenderJobInput {
  jobId: string;
  takeKeys: string[];
  compositionProps: Record<string, unknown>;
  onProgress: (pct: number) => void;
}

export interface RenderJobDeps {
  renderer: RemotionRenderer;
  downloadTake: (key: string, destPath: string) => Promise<void>;
  tmpDir: string;
  /** Directory where the bundle's `public/` lives — takes are placed under
      `{publicDir}/{jobId}/`. */
  publicDir: string;
  remotionEntry: string;
}

// Bundle cache keyed on the renderer instance so that:
// 1. The bundle is compiled only once per container lifetime in production
//    (deps object is constructed once and reused for every job).
// 2. Test suites that construct separate renderer mocks each get an
//    independent cache entry, so mock call-count assertions stay clean.
const bundleCache = new WeakMap<RemotionRenderer, string>();

export async function renderJob(input: RenderJobInput, deps: RenderJobDeps): Promise<{ outputPath: string }> {
  const cached = bundleCache.get(deps.renderer);
  const serveUrl = cached ?? await (async () => {
    const url = await deps.renderer.bundle(deps.remotionEntry);
    bundleCache.set(deps.renderer, url);
    return url;
  })();

  // Download each take into the bundle's public dir under the jobId so
  // Remotion can resolve them through staticFile().
  await Promise.all(
    input.takeKeys.map(async (key) => {
      const takeId = path.basename(key);
      await deps.downloadTake(key, path.join(deps.publicDir, input.jobId, takeId));
    }),
  );

  const composition = await deps.renderer.selectComposition({
    serveUrl,
    id: 'spooool-video',
    inputProps: { takes: input.takeKeys, ...input.compositionProps },
  });

  const outputPath = path.join(deps.tmpDir, input.jobId, `${input.jobId}.mp4`);
  await deps.renderer.renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: { takes: input.takeKeys, ...input.compositionProps },
    onProgress: (p) => input.onProgress(Math.round(p.progress * 100)),
  });

  return { outputPath };
}
