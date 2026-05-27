// Root of the prompt-to-video page. Picks a template, switches between
// Auto / Guided modes, and (when `debug` is true) renders the live debug
// panel with model + cost breakdown.

import { useCallback, useEffect, useState } from 'react';
import { ApiError, listTemplates } from './lib/create-client';
import type { TemplateMetadata } from './lib/template';
import { AutoMode } from './AutoMode';
import { GuidedMode } from './GuidedMode';
import { Spinner } from './Spinner';
import { CostPanel } from './CostPanel';
import { DebugPanel } from './DebugPanel';

interface CreateRootProps {
  /** Render the debug panel + verbose status pings. Toggled by ?debug=1. */
  debug?: boolean;
}

export function CreateRoot({ debug }: CreateRootProps = {}): JSX.Element {
  const [templates, setTemplates] = useState<TemplateMetadata[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'guided'>('auto');
  const [lastError, setLastError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listTemplates().then((ts) => {
      if (cancelled) return;
      setTemplates(ts);
      if (ts.length === 1) setTemplateId(ts[0].id);
    }).catch((err: unknown) => {
      if (cancelled) return;
      const e = err instanceof Error ? err : new Error(String(err));
      setLoadError(e);
      setLastError(e);
      setTemplates([]);
    });
    return () => { cancelled = true; };
  }, []);

  const handleError = useCallback((err: Error) => setLastError(err), []);

  if (templates === null) {
    return (
      <div className="card stack" style={{ padding: 24 }}>
        <Spinner label="Loading templates…" />
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
          If this hangs for more than ~15 seconds, check the debug panel below.
        </p>
        {debug ? <DebugPanel jobId={null} lastError={lastError} /> : null}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="stack">
        <div className="alert alert--error" role="alert">
          <strong>Couldn't load templates.</strong>
          <p style={{ marginTop: 4 }}>{loadError.message}</p>
          {loadError instanceof ApiError && loadError.status === 401 ? (
            <p style={{ marginTop: 4 }}>Your session may have expired. Reload the page to sign in again.</p>
          ) : null}
          <button className="btn" onClick={() => window.location.reload()} style={{ marginTop: 8 }}>
            Reload
          </button>
        </div>
        {debug ? <DebugPanel jobId={null} lastError={loadError} /> : null}
      </div>
    );
  }

  if (templates.length === 0) {
    return <p style={{ padding: 16 }}>No templates available.</p>;
  }

  if (!templateId) {
    return (
      <div className="stack">
        <h2 className="ds-h2">Pick a story type</h2>
        {templates.map((t) => (
          <button key={t.id} className="btn" onClick={() => setTemplateId(t.id)}>
            <strong>{t.name}</strong> — {t.description}
          </button>
        ))}
        <CostPanel collapsed />
        {debug ? <DebugPanel jobId={null} lastError={lastError} /> : null}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="stack-sm">
        <span className="ds-label">{templates.find((t) => t.id === templateId)?.name}</span>
        <div role="tablist" style={{ display: 'flex', gap: 8 }}>
          <button
            role="tab"
            aria-selected={mode === 'auto'}
            className={`btn ${mode === 'auto' ? 'btn--primary' : ''}`}
            onClick={() => setMode('auto')}
          >
            ⚡ Auto
          </button>
          <button
            role="tab"
            aria-selected={mode === 'guided'}
            className={`btn ${mode === 'guided' ? 'btn--primary' : ''}`}
            onClick={() => setMode('guided')}
          >
            🧭 Guided
          </button>
        </div>
      </div>
      {mode === 'auto'
        ? <AutoMode templateId={templateId} onError={handleError} />
        : <GuidedMode templateId={templateId} onError={handleError} />}
      <CostPanel collapsed={!debug} />
      {debug ? <DebugPanel jobId={null} lastError={lastError} /> : null}
    </div>
  );
}
