// Debug panel — visible when /create?debug=1 is set, OR when the user
// toggles "Show debug" on the page. Surfaces the live render-job state +
// any structured error coming back from the worker so the user can see
// exactly what's happening without needing wrangler tail.

import { useEffect, useState, type JSX } from 'react';
import { ApiError, fetchJobStatus, type RenderJobStatus } from './lib/create-client';
import { STAGE_COSTS } from './lib/cost-estimates';

interface DebugPanelProps {
  jobId: string | null;
  /** The most recent ApiError caught by the form, if any. */
  lastError?: ApiError | Error | null;
}

interface DebugSnapshot {
  ts: string;
  status?: RenderJobStatus;
  error?: string;
}

export function DebugPanel({ jobId, lastError }: DebugPanelProps): JSX.Element {
  const [history, setHistory] = useState<DebugSnapshot[]>([]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const status = await fetchJobStatus(jobId!);
        if (cancelled) return;
        setHistory((h) => [...h.slice(-50), { ts: new Date().toISOString(), status }]);
        if (status.status === 'completed' || status.status === 'failed') return;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setHistory((h) => [...h.slice(-50), { ts: new Date().toISOString(), error: msg }]);
      }
      timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  return (
    <details className="card card--tight" open>
      <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Debug log</summary>
      <div className="stack-sm" style={{ marginTop: 12 }}>
        <div>
          <strong>Active job:</strong> {jobId ? <code>{jobId}</code> : <em>none yet</em>}
        </div>

        {lastError ? (
          <div className="alert alert--error">
            <strong>Last error</strong>
            <div style={{ marginTop: 4 }}>{lastError.message}</div>
            {lastError instanceof ApiError ? (
              <pre className="debug-log" style={{ marginTop: 8 }}>
                {JSON.stringify({ status: lastError.status, route: lastError.route, body: lastError.body }, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div>
          <strong>Toolchain</strong>
          <ul style={{ marginTop: 4 }}>
            {STAGE_COSTS.map((s) => (
              <li key={s.stage}><code>{s.stage}</code> → <code>{s.route}</code> ({s.resolvedModel})</li>
            ))}
          </ul>
        </div>

        <div>
          <strong>Job state history</strong>
          {history.length === 0 ? (
            <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
              Submit a job to see polling state.
            </p>
          ) : (
            <pre className="debug-log">
              {history.map((h) => `[${h.ts}] ${h.error ? `ERROR ${h.error}` : JSON.stringify(h.status)}`).join('\n')}
            </pre>
          )}
        </div>

        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
          For richer worker-side logs, run <code>npx wrangler tail spooool</code>.
        </p>
      </div>
    </details>
  );
}
