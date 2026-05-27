import { useEffect, useState } from 'react';
import { fetchRenderStatus, type RenderJobStatus } from './lib/render-jobs';

export function RenderProgress({ jobId }: { jobId: string }): JSX.Element {
  const [status, setStatus] = useState<RenderJobStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        const next = await fetchRenderStatus(jobId);
        if (cancelled) return;
        setStatus(next);
        setPollError(null);
        if (next.status === 'completed' && next.videoId) {
          // The recorder is a standalone app; navigate via window.location
          // rather than react-router-dom (which is not mounted here).
          window.location.href = `/watch/${next.videoId}`;
          return;
        }
        if (next.status === 'failed') {
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : String(err));
        // Keep polling — transient errors shouldn't kill the watch.
      }
      timer = setTimeout(poll, 2000);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (!status) {
    return <p style={{ padding: 16 }}>Starting render…</p>;
  }
  if (status.status === 'failed') {
    return (
      <div role="alert" style={{ padding: 16, color: 'crimson' }}>
        <p><strong>Render failed.</strong></p>
        <p>{status.error ?? 'Unknown error'}</p>
      </div>
    );
  }
  return (
    <div style={{ padding: 16 }}>
      <p>{status.status === 'queued' ? 'Queued…' : `Rendering ${status.progress}%`}</p>
      <progress value={status.progress} max={100} style={{ width: '100%' }} />
      <p style={{ opacity: 0.7 }}>This usually takes a couple minutes.</p>
      {pollError ? <p style={{ opacity: 0.5, fontSize: '0.9em' }}>Connection issue, retrying… ({pollError})</p> : null}
    </div>
  );
}
