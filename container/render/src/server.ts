// HTTP entrypoint for the render container. Worker hits POST /render with
// the job spec. We immediately accept (200) or reject for capacity (429),
// then asynchronously: render via injected renderer, upload the MP4 to R2,
// and POST back to the worker's /complete (or /fail on error) endpoint.
//
// Also serves POST /encode for the R2+FFmpeg HLS fallback path (ALO-136).
// Encode jobs use a separate queue so they don't compete with render slots.
//
// In-memory queue (max 3 pending per type) keeps each container instance from
// being hammered. Since the worker dispatches one instance per user (render)
// or pool slot (encode), this bounds concurrent work per instance.

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { RenderQueue } from './queue.js';

export interface ServerDeps {
  renderJob: (job: {
    jobId: string;
    takeKeys: string[];
    compositionProps: Record<string, unknown>;
    onProgress: (pct: number) => void;
  }) => Promise<{ outputPath: string }>;
  uploadToR2: (jobId: string, localPath: string) => Promise<string>;
  encodeToHls: (opts: { videoId: string; r2Key: string }) => Promise<{ masterKey: string; thumbnailKey: string | null }>;
  callbackToWorker: (path: string, body: unknown) => Promise<void>;
  queueMax: number;
}

export function createServer(deps: ServerDeps) {
  // pending: jobs enqueued but not yet dequeued by drain
  // active: job currently being rendered (dequeued but not yet complete)
  // capacity is shared: pending + active must not exceed queueMax
  const queue = new RenderQueue({ maxPending: deps.queueMax });
  let activeCount = 0;
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      let job = queue.next();
      while (job) {
        const current = job;
        activeCount++;
        try {
          await deps.callbackToWorker(`/api/render/jobs/${current.jobId}/progress`, { progress: 0 });
          const onProgress = (pct: number) => {
            void deps.callbackToWorker(`/api/render/jobs/${current.jobId}/progress`, { progress: pct });
          };
          const { outputPath } = await deps.renderJob({
            jobId: current.jobId,
            takeKeys: current.takeKeys ?? [],
            compositionProps: current.compositionProps ?? {},
            onProgress,
          });
          const key = await deps.uploadToR2(current.jobId, outputPath);
          await deps.callbackToWorker(`/api/render/jobs/${current.jobId}/complete`, { outputKey: key });
        } catch (err) {
          await deps.callbackToWorker(`/api/render/jobs/${current.jobId}/fail`, {
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => { /* swallow callback errors — the worker has the stuck-job sweep as backstop */ });
        } finally {
          activeCount--;
        }
        job = queue.next();
      }
    } finally {
      draining = false;
    }
  }

  // Separate encode queue so encode jobs don't consume render slots.
  const encodeQueue = new RenderQueue({ maxPending: deps.queueMax });
  let encodeActiveCount = 0;
  let encodeDraining = false;

  async function drainEncode(): Promise<void> {
    if (encodeDraining) return;
    encodeDraining = true;
    try {
      let job = encodeQueue.next();
      while (job) {
        const current = job;
        encodeActiveCount++;
        try {
          const result = await deps.encodeToHls({
            videoId: current.jobId,   // jobId is videoId for encode jobs
            r2Key: current.takeKeys?.[0] ?? '',
          });
          await deps.callbackToWorker(`/api/webhooks/encode/${current.jobId}/complete`, {
            masterKey: result.masterKey,
            thumbnailKey: result.thumbnailKey,
          });
        } catch (err) {
          await deps.callbackToWorker(`/api/webhooks/encode/${current.jobId}/fail`, {
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => {});
        } finally {
          encodeActiveCount--;
        }
        job = encodeQueue.next();
      }
    } finally {
      encodeDraining = false;
    }
  }

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/render', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      jobId?: string;
      takeKeys?: string[];
      compositionProps?: Record<string, unknown>;
    } | null;
    if (!body?.jobId) {
      return c.json({ error: 'jobId required' }, 400);
    }
    // Reject if total slots (pending + active) are at capacity
    if (queue.size + activeCount >= deps.queueMax) {
      return c.json({ error: 'queue full', retryAfterSeconds: 60 }, 429);
    }
    queue.enqueue({
      jobId: body.jobId,
      takeKeys: body.takeKeys,
      compositionProps: body.compositionProps,
    });
    void drain();
    return c.json({ ok: true });
  });

  app.post('/encode', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      videoId?: string;
      r2Key?: string;
    } | null;
    if (!body?.videoId || !body.r2Key) {
      return c.json({ error: 'videoId and r2Key required' }, 400);
    }
    if (encodeQueue.size + encodeActiveCount >= deps.queueMax) {
      return c.json({ error: 'encode queue full', retryAfterSeconds: 60 }, 429);
    }
    // Reuse RenderQueue; store r2Key in takeKeys[0] for simplicity.
    encodeQueue.enqueue({ jobId: body.videoId, takeKeys: [body.r2Key] });
    void drainEncode();
    return c.json({ ok: true });
  });

  return app;
}

// --- Production entrypoint (runs when `node dist/server.js` starts) ---
//
// Strategy: keep this top-level minimal — only @hono/node-server and a stub
// Hono server with /health, /render, /diagnostic. The heavy dependencies
// (@remotion/*, @aws-sdk/*) are deferred to first use inside the /render
// handler. That way the container always boots, and any startup-time error
// from those modules surfaces as a /fail callback to the worker (visible in
// `wrangler tail`) instead of an opaque "container failed to start".

async function bootstrap(): Promise<void> {
  console.log('[render-container] booting…');
  // @hono/node-server is deferred so the module stays import-safe (and so a
  // missing native dep surfaces at boot, not import). Hono itself is already
  // imported at the top of the file — reuse it rather than re-importing and
  // shadowing the top-level binding.
  const { serve } = await import('@hono/node-server');

  const port = Number(process.env.PORT ?? 8080);
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/diagnostic', (c) =>
    c.json({
      cwd: process.cwd(),
      argv: process.argv,
      env_present: {
        R2_S3_ENDPOINT: Boolean(process.env.R2_S3_ENDPOINT),
        R2_ACCESS_KEY_ID: Boolean(process.env.R2_ACCESS_KEY_ID),
        R2_SECRET_ACCESS_KEY: Boolean(process.env.R2_SECRET_ACCESS_KEY),
        RENDER_CALLBACK_SECRET: Boolean(process.env.RENDER_CALLBACK_SECRET),
        WORKER_BASE_URL: Boolean(process.env.WORKER_BASE_URL),
      },
    }),
  );

  let heavyServer: ReturnType<typeof createServer> | null = null;
  let heavyServerError: string | null = null;
  let initPromise: Promise<void> | null = null;

  async function ensureHeavyServer(): Promise<{ ok: true; app: ReturnType<typeof createServer> } | { ok: false; error: string }> {
    if (heavyServer) return { ok: true, app: heavyServer };
    if (heavyServerError) return { ok: false, error: heavyServerError };
    if (!initPromise) {
      initPromise = (async () => {
        const workerBase = process.env.WORKER_BASE_URL ?? 'https://spooool.com';
        const callbackSecret = process.env.RENDER_CALLBACK_SECRET ?? '';
        const callbackToWorker = async (callbackPath: string, body: unknown): Promise<void> => {
          const res = await fetch(`${workerBase}${callbackPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-render-secret': callbackSecret },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`worker callback ${callbackPath} -> ${res.status}`);
        };

        try {
          console.log('[render-container] loading heavy deps…');
          const { bundle } = await import('@remotion/bundler');
          const { renderMedia, selectComposition } = await import('@remotion/renderer');
          const { S3Client, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const { renderJob } = await import('./render.js');
          const { encodeToHls } = await import('./encode.js');
          console.log('[render-container] heavy deps loaded');

          const s3 = new S3Client({
            region: 'auto',
            endpoint: process.env.R2_S3_ENDPOINT!,
            credentials: {
              accessKeyId: process.env.R2_ACCESS_KEY_ID!,
              secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
            },
          });
          const bucket = process.env.R2_BUCKET ?? 'spooool-videos';
          const remotionEntry = process.env.REMOTION_ENTRY ?? path.resolve('./remotion/index.ts');
          const tmpDir = process.env.TMP_DIR ?? '/tmp';
          const publicDir = path.resolve('./remotion/public');

          const downloadTake = async (key: string, dest: string): Promise<void> => {
            await fs.mkdir(path.dirname(dest), { recursive: true });
            const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            if (!out.Body) throw new Error(`take ${key} not found in R2`);
            const buf = Buffer.from(await out.Body.transformToByteArray());
            await fs.writeFile(dest, buf);
          };

          heavyServer = createServer({
            renderJob: (input) =>
              renderJob(input, {
                renderer: {
                  bundle,
                  selectComposition: (a) => selectComposition(a as never) as never,
                  renderMedia: (a) => renderMedia(a as never) as never,
                },
                downloadTake,
                tmpDir,
                publicDir,
                remotionEntry,
              }),
            uploadToR2: async (jobId, localPath) => {
              const key = `recorder/renders/${jobId}.mp4`;
              const body = await fs.readFile(localPath);
              await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4' }));
              return key;
            },
            encodeToHls: (opts) => encodeToHls({ ...opts, s3, bucket }),
            callbackToWorker,
            queueMax: 3,
          });
          console.log('[render-container] heavy server ready');
        } catch (err) {
          const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
          heavyServerError = msg;
          console.error('[render-container] heavy init FAILED:', msg);
        }
      })();
    }
    await initPromise;
    if (heavyServer) return { ok: true, app: heavyServer };
    return { ok: false, error: heavyServerError ?? 'unknown init failure' };
  }

  function forwardToHeavyServer(
    init: { ok: true; app: ReturnType<typeof createServer> } | { ok: false; error: string },
    rawBody: string,
    originalReq: Request,
  ): Response | ReturnType<ReturnType<typeof createServer>['fetch']> {
    if (!init.ok) {
      return Response.json({ error: 'container init failed', detail: init.error.slice(0, 800) }, { status: 503 });
    }
    // Strip framing headers — the body we forward is already-decoded text, so
    // the original wire framing (content-length/encoding/transfer-encoding) no
    // longer applies. Let the Request constructor derive a fresh content-length.
    const innerHeaders = new Headers(originalReq.headers);
    innerHeaders.delete('content-length');
    innerHeaders.delete('content-encoding');
    innerHeaders.delete('transfer-encoding');
    return init.app.fetch(new Request(originalReq.url, {
      method: 'POST',
      headers: innerHeaders,
      body: rawBody,
    }));
  }

  app.post('/render', async (c) => {
    const rawBody = await c.req.text();
    let parsedJobId: string | undefined;
    try {
      parsedJobId = (JSON.parse(rawBody) as { jobId?: string }).jobId;
    } catch { /* malformed JSON — leave parsedJobId undefined */ }

    const init = await ensureHeavyServer();
    if (!init.ok) {
      if (parsedJobId) {
        const workerBase = process.env.WORKER_BASE_URL ?? 'https://spooool.com';
        const callbackSecret = process.env.RENDER_CALLBACK_SECRET ?? '';
        void fetch(`${workerBase}/api/render/jobs/${parsedJobId}/fail`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-render-secret': callbackSecret },
          body: JSON.stringify({ error: `Container init failed: ${init.error.slice(0, 800)}` }),
        }).catch(() => {});
      }
    }
    return forwardToHeavyServer(init, rawBody, c.req.raw);
  });

  // The R2+FFmpeg encoding path (ALO-136) dispatches jobs via POST /encode.
  // This bootstrap handler mirrors the /render proxy: it ensures the heavy
  // server is initialised, then forwards the request. On init failure it fires
  // the /fail webhook so the Worker marks the video as failed rather than
  // leaving it stuck in 'encoding'.
  app.post('/encode', async (c) => {
    const rawBody = await c.req.text();
    let parsedVideoId: string | undefined;
    try {
      parsedVideoId = (JSON.parse(rawBody) as { videoId?: string }).videoId;
    } catch { /* malformed JSON */ }

    const init = await ensureHeavyServer();
    if (!init.ok && parsedVideoId) {
      const workerBase = process.env.WORKER_BASE_URL ?? 'https://spooool.com';
      const callbackSecret = process.env.RENDER_CALLBACK_SECRET ?? '';
      void fetch(`${workerBase}/api/webhooks/encode/${parsedVideoId}/fail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': callbackSecret },
        body: JSON.stringify({ error: `Container init failed: ${init.error.slice(0, 800)}` }),
      }).catch(() => {});
    }
    return forwardToHeavyServer(init, rawBody, c.req.raw);
  });

  serve({ fetch: app.fetch, port });
  console.log(`[render-container] listening on :${port}`);
}

// Only run bootstrap when this file is the process entrypoint (i.e.
// `node dist/server.js`), never when it is merely imported — e.g. by
// server.test.ts importing `createServer`. Importing must NOT start a real
// @hono/node-server listener on port 8080 (open handles / EADDRINUSE in CI).
//
// The naive `import.meta.url === \`file://${process.argv[1]}\`` guard can
// false-negative when the entrypoint is a symlink or a differently-resolved
// path, so resolve both sides through fs.realpathSync before comparing.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const thisPath = fileURLToPath(import.meta.url);
    return realpathSync(thisPath) === realpathSync(entry);
  } catch {
    // Fall back to the URL comparison if realpath resolution fails.
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isMainModule()) {
  void bootstrap().catch((err) => {
    console.error('[render-container] bootstrap FAILED:', err);
    process.exit(1);
  });
}
