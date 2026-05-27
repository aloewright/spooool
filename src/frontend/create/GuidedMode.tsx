// src/frontend/create/GuidedMode.tsx
import { useEffect, useRef, useState } from 'react';
import { connectSessionStream, createSession, fetchJobStatus } from './lib/create-client';
import type { Question } from './lib/template';

interface GuidedModeProps { templateId: string }

type WSMessage =
  | { type: 'question'; question: Question }
  | { type: 'questions_complete' }
  | { type: 'status'; stage: string }
  | { type: 'render_started'; jobId: string }
  | { type: 'error'; error: string };

export function GuidedMode({ templateId }: GuidedModeProps): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [questionsComplete, setQuestionsComplete] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          else if (msg.type === 'error') setError(msg.error);
        };
        ws.onerror = () => setError('Connection error');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; wsRef.current?.close(); };
  }, [templateId]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const s = await fetchJobStatus(jobId!);
        if (cancelled) return;
        if (s.status === 'completed' && s.videoId) { window.location.href = `/watch/${s.videoId}`; return; }
        if (s.status === 'failed') { setError(s.error ?? 'Render failed'); return; }
      } catch { /* transient */ }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  function sendAnswer(): void {
    if (!answer.trim() || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'answer', text: answer.trim() }));
  }
  function generate(): void {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'generate' }));
  }

  if (error) return <p role="alert" style={{ color: 'crimson', padding: 16 }}>{error}</p>;
  if (!sessionId) return <p style={{ padding: 16 }}>Starting session…</p>;
  if (jobId) return <p style={{ padding: 16 }}>Rendering ({stage ?? 'queued'})…</p>;
  if (questionsComplete) {
    return (
      <div className="card stack">
        <p>All questions answered. Ready to generate the video?</p>
        <button className="btn btn--primary" onClick={generate}>Generate video</button>
      </div>
    );
  }
  if (!question) return <p style={{ padding: 16 }}>Loading…</p>;
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
