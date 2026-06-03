// AIStudio — real-time chat component for the AI Studio page.
// Sends messages to ALO-644's POST /api/studio/chat endpoint via SSE.
// Rate limit: 30 studio requests per hour.

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { UIMessage } from '@tanstack/ai-client';
import { useChat } from '@tanstack/ai-react';
import { Spinner } from '../create/Spinner';
import { studioChatConnection } from './lib/studio-client';

/** Extract the combined text from a UIMessage's text parts. */
function messageText(m: UIMessage): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; content: string }).content)
    .join('');
}

export function AIStudio(): JSX.Element {
  const { messages, sendMessage, isLoading, error } = useChat({
    connection: studioChatConnection(),
  });

  const [input, setInput] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the message log to bottom when new messages arrive.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const t = input.trim();
    if (!t) return;
    setInput('');
    void sendMessage(t);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter submits; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.trim();
      if (!t || isLoading) return;
      setInput('');
      void sendMessage(t);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="card stack">
      {/* Message log */}
      <div
        ref={logRef}
        aria-live="polite"
        style={{ maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {messages.length === 0 ? (
          <p className="ds-empty ds-meta">
            Ask for video ideas, titles, scripts, or thumbnails.
          </p>
        ) : (
          messages.map((m) => {
            const isUser = m.role === 'user';
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: isUser ? 'flex-end' : 'flex-start',
                  background: isUser ? 'var(--muted)' : 'transparent',
                  borderRadius: 8,
                  padding: '6px 10px',
                  maxWidth: '85%',
                }}
              >
                <span
                  className="ds-meta"
                  style={{ display: 'block', marginBottom: 2 }}
                >
                  {isUser ? 'You' : 'Studio'}
                </span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{messageText(m)}</span>
              </div>
            );
          })
        )}
        {isLoading ? (
          <div style={{ alignSelf: 'flex-start', padding: '6px 10px' }}>
            <span className="ds-meta" style={{ display: 'block', marginBottom: 2 }}>
              Studio
            </span>
            <Spinner size={16} inline label="Studio is thinking…" />
          </div>
        ) : null}
      </div>

      {/* Error */}
      {error ? (
        <div className="alert alert--error" role="alert">
          <strong>{error.message}</strong>
          <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
            Limit: 30 studio requests per hour.
          </p>
        </div>
      ) : null}

      {/* Composer */}
      <label className="field">
        <span className="field__label">Message</span>
        <textarea
          className="input"
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask for video ideas, titles, scripts, or thumbnails…"
          disabled={isLoading}
        />
      </label>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={!input.trim() || isLoading}
      >
        {isLoading ? <Spinner size={16} inline label="Submitting…" /> : 'Send'}
      </button>
    </form>
  );
}
