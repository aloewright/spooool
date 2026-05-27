// HTTP entrypoint for the render container. Worker hits POST /render with
// the job spec. We immediately accept (200) or reject for capacity (429),
// then asynchronously: render via injected renderer, upload the MP4 to R2,
// and POST back to the worker's /complete (or /fail on error) endpoint.
//
// In-memory queue (max 3 pending) keeps each container instance from being
// hammered. Since the worker dispatches one instance per user, this also
// bounds how many simultaneous renders one user can run.

import { Hono } from 'hono';
import { RenderQueue } from './queue';

export interface ServerDeps {
  renderJob: (job: {
    jobId: string;
    takeKeys: string[];
    compositionProps: Record<string, unknown>;
    onProgress: (pct: number) => void;
  }) => Promise<{ outputPath: string }>;
  uploadToR2: (jobId: string, localPath: string) => Promise<string>;
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

  return app;
}
