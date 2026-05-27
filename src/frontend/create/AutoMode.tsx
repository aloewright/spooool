// AutoMode — one-shot generation flow.
// User types a prompt, clicks Generate, and the page polls /jobs/:id every
// 2s. Loading + error states get visible treatment (Spinner, alert, retry)
// so a stuck or failed job is never invisible.

import { FormEvent, useEffect, useState } from 'react';
import { ApiError, createAutoJob, fetchJobStatus, type RenderJobStatus } from './lib/create-client';
import { Spinner } from './Spinner';

interface AutoModeProps {
  templateId: string;
  /** When set, `onError` is invoked so the parent's DebugPanel can render it. */
  onError?: (err: Error) => void;
}

// After this many consecutive failed polls we surface "polling stalled" so
// the user can see something's wrong instead of waiting indefinitely.
const POLL_STALL_THRESHOLD = 5;

export function AutoMode({ templateId, onError }: AutoModeProps): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<RenderJobStatus | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | Error | null>(null);
  const [pollErrors, setPollErrors] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const { jobId } = await createAutoJob({ templateId, prompt });
      setJobId(jobId);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setSubmitError(e);
      onError?.(e);
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const s = await fetchJobStatus(jobId!);
        if (cancelled) return;
        setStatus(s);
        setPollErrors(0);
        if (s.status === 'completed' && s.videoId) {
          window.location.href = `/watch/${s.videoId}`;
          return;
        }
        if (s.status === 'failed') return;
      } catch (err) {
        if (cancelled) return;
        setPollErrors((n) => n + 1);
        // After enough consecutive errors, surface to onError so the debug
        // panel reflects what's happening.
        if (err instanceof Error) onError?.(err);
      }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId, onError]);

  function reset(): void {
    setJobId(null);
    setStatus(null);
    setSubmitError(null);
    setPollErrors(0);
  }

  if (jobId) {
    const failed = status?.status === 'failed';
    const stalled = !status && pollErrors >= POLL_STALL_THRESHOLD;
    const determinate = status && status.status === 'rendering' && status.progress > 0;
    return (
      <div className="stack" style={{ padding: 16 }}>
        {failed ? (
          <div className="alert alert--error" role="alert">
            <strong>Generation failed.</strong>
            <p style={{ marginTop: 4 }}>{status?.error ?? 'Unknown error — check the debug panel below.'}</p>
            <button className="btn" onClick={reset} style={{ marginTop: 8 }}>Try again</button>
          </div>
        ) : stalled ? (
          <div className="alert alert--error" role="alert">
            <strong>Connection problem.</strong>
            <p style={{ marginTop: 4 }}>
              Couldn't reach the job status endpoint after {POLL_STALL_THRESHOLD} attempts.
              The render may still be running — try refreshing the page in a minute, or open the debug panel below.
            </p>
            <button className="btn" onClick={reset} style={{ marginTop: 8 }}>Cancel</button>
          </div>
        ) : (
          <>
            <Spinner label={
              !status ? 'Starting toolchain…'
              : status.status === 'queued' ? 'Queued — drafting script…'
              : `Rendering ${status.progress}%`
            } />
            <div className="progress-track" aria-hidden="true">
              <div
                className={`progress-track__fill ${determinate ? '' : 'progress-track__fill--indeterminate'}`}
                style={determinate ? { width: `${status!.progress}%` } : undefined}
              />
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
              Job <code>{jobId}</code>. This typically takes 1–2 minutes.
            </p>
          </>
        )}
      </div>
    );
  }

  const fieldErrors = submitError instanceof ApiError ? submitError.fieldErrors : null;

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="card stack">
      <label className="field">
        <span className="field__label">What's the story?</span>
        <textarea
          className="input"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2000}
          placeholder="e.g., A junior developer learns Cloudflare Workers and ships their first app"
          required
        />
        {fieldErrors?.prompt ? (
          <span className="field__error" style={{ color: 'crimson', fontSize: 'var(--text-sm)' }}>
            {fieldErrors.prompt.join(', ')}
          </span>
        ) : null}
      </label>
      {submitError ? (
        <div className="alert alert--error" role="alert">
          <strong>Couldn't start the generation.</strong>
          <p style={{ marginTop: 4 }}>{submitError.message}</p>
          {submitError instanceof ApiError && submitError.status === 429 ? (
            <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
              Rate limit: 5 generations per hour per account.
            </p>
          ) : null}
          {submitError instanceof ApiError && submitError.formErrors.length > 0 ? (
            <ul>{submitError.formErrors.map((m, i) => <li key={i}>{m}</li>)}</ul>
          ) : null}
        </div>
      ) : null}
      <button
        type="submit"
        className="btn btn--primary"
        disabled={!prompt.trim() || submitting}
      >
        {submitting ? <Spinner size={16} inline label="Submitting…" /> : 'Generate video'}
      </button>
    </form>
  );
}
