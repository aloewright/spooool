// GuidedMode — interactive Q&A flow.
// Opens a session, walks 7 hero-journey questions over WebSocket, then
// kicks off the same toolchain Auto mode uses. Stage indicator + spinner +
// alert blocks replace the bare-text states this used to render.

import { useEffect, useRef, useState, type JSX } from 'react';
import { ApiError, connectSessionStream, createSession, fetchJobStatus } from './lib/create-client';
import type { Question } from './lib/template';
import { Spinner } from './Spinner';

interface GuidedModeProps {
  templateId: string;
  /** Bubbled to parent so the debug panel can display it. */
  onError?: (err: Error) => void;
}

type WSMessage =
  | { type: 'question'; question: Question }
  | { type: 'questions_complete' }
  | { type: 'status'; stage: string }
  | { type: 'render_started'; jobId: string }
  | { type: 'error'; error: string };

const STAGE_LABELS: Record<string, string> = {
  drafting: 'Drafting narration script',
  planning: 'Planning scenes',
  tts: 'Synthesizing voiceover',
  rendering: 'Rendering composition',
};

export function GuidedMode({ templateId, onError }: GuidedModeProps): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [questionsComplete, setQuestionsComplete] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { sessionId, firstQuestion } = await createSession({ templateId });
        if (cancelled) return;
        setSessionId(sessionId);
        setQuestion(firstQuestion);
        const ws = connectSessionStream(sessionId);
        wsRef.current = ws;
        ws.onmessage = (evt) => {
          const msg = JSON.parse(evt.data) as WSMessage;
          if (msg.type === 'question') { setQuestion(msg.question); setAnswer(''); }
          else if (msg.type === 'questions_complete') { setQuestionsComplete(true); setQuestion(null); }
          else if (msg.type === 'status') setStage(msg.stage);
          else if (msg.type === 'render_started') setJobId(msg.jobId);
          else if (msg.type === 'error') {
            const err = new Error(msg.error);
            setError(err);
            onError?.(err);
          }
        };
        ws.onerror = () => {
          const err = new Error('WebSocket connection error');
          setError(err);
          onError?.(err);
        };
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        onError?.(e);
      }
    })();
    return () => { cancelled = true; wsRef.current?.close(); };
  }, [templateId, onError]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const s = await fetchJobStatus(jobId!);
        if (cancelled) return;
        if (s.status === 'completed' && s.videoId) { window.location.href = `/watch/${s.videoId}`; return; }
        if (s.status === 'failed') {
          const err = new Error(s.error ?? 'Render failed');
          setError(err);
          onError?.(err);
          return;
        }
      } catch (err) {
        if (err instanceof Error) onError?.(err);
      }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId, onError]);

  function sendAnswer(): void {
    if (!answer.trim() || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'answer', text: answer.trim() }));
  }
  function generate(): void {
    if (!wsRef.current) return;
    setStage('drafting');
    wsRef.current.send(JSON.stringify({ type: 'generate' }));
  }

  if (error) {
    return (
      <div className="alert alert--error" role="alert">
        <strong>Session failed.</strong>
        <p style={{ marginTop: 4 }}>{error.message}</p>
        {error instanceof ApiError && error.status === 429 ? (
          <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
            Rate limit: 5 generations per hour per account.
          </p>
        ) : null}
        <button className="btn" onClick={() => window.location.reload()} style={{ marginTop: 8 }}>Try again</button>
      </div>
    );
  }
  if (!sessionId) {
    return (
      <div className="card stack" style={{ padding: 16 }}>
        <Spinner label="Starting session…" />
      </div>
    );
  }
  if (jobId) {
    return (
      <div className="stack" style={{ padding: 16 }}>
        <Spinner label={STAGE_LABELS[stage ?? 'rendering'] ?? `Stage: ${stage}`} />
        <div className="progress-track" aria-hidden="true">
          <div className="progress-track__fill progress-track__fill--indeterminate" />
        </div>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
          Job <code>{jobId}</code>. This typically takes 1–2 minutes.
        </p>
      </div>
    );
  }
  if (stage) {
    // We've sent {type:'generate'} but no render_started yet — show stage indicator.
    return (
      <div className="stack" style={{ padding: 16 }}>
        <Spinner label={STAGE_LABELS[stage] ?? `Stage: ${stage}`} />
      </div>
    );
  }
  if (questionsComplete) {
    return (
      <div className="card stack">
        <p>All questions answered. Ready to generate the video?</p>
        <button className="btn btn--primary" onClick={generate}>Generate video</button>
      </div>
    );
  }
  if (!question) {
    return (
      <div className="card stack" style={{ padding: 16 }}>
        <Spinner label="Loading next question…" />
      </div>
    );
  }
  return (
    <div className="card stack">
      <label className="field">
        <span className="field__label">{question.text}</span>
        {question.multiline ? (
          <textarea className="input" rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={question.hint} />
        ) : (
          <input className="input" type="text" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={question.hint} />
        )}
      </label>
      <button className="btn btn--primary" onClick={sendAnswer} disabled={!answer.trim()}>Next</button>
    </div>
  );
}
