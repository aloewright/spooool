// src/frontend/create/AutoMode.tsx
import { FormEvent, useEffect, useState } from 'react';
import { createAutoJob, fetchJobStatus } from './lib/create-client';

interface AutoModeProps { templateId: string }

export function AutoMode({ templateId }: AutoModeProps): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ status: string; progress: number; videoId?: string | null; error?: string | null } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    try {
      const { jobId } = await createAutoJob({ templateId, prompt });
      setJobId(jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
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
        if (s.status === 'completed' && s.videoId) {
          window.location.href = `/watch/${s.videoId}`;
          return;
        }
        if (s.status === 'failed') return;
      } catch { /* keep polling on transient errors */ }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  if (jobId) {
    return (
      <div className="stack" style={{ padding: 16 }}>
        {!status ? <p>Starting…</p> : status.status === 'failed' ? (
          <div role="alert" style={{ color: 'crimson' }}><p>Generation failed.</p><p>{status.error ?? 'Unknown error'}</p></div>
        ) : (
          <>
            <p>{status.status === 'queued' ? 'Queued…' : `Rendering ${status.progress}%`}</p>
            <progress value={status.progress} max={100} style={{ width: '100%' }} />
          </>
        )}
      </div>
    );
  }

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
          required
        />
      </label>
      {submitError ? <p role="alert" style={{ color: 'crimson' }}>{submitError}</p> : null}
      <button type="submit" className="btn btn--primary" disabled={!prompt.trim()}>Generate video</button>
    </form>
  );
}
