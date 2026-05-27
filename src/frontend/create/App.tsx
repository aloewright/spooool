// src/frontend/create/App.tsx
import { useEffect, useState } from 'react';
import { listTemplates } from './lib/create-client';
import type { TemplateMetadata } from './lib/template';
import { AutoMode } from './AutoMode';
import { GuidedMode } from './GuidedMode';

export function CreateRoot(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateMetadata[] | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'guided'>('auto');

  useEffect(() => {
    void listTemplates()
      .then((ts) => {
        setTemplates(ts);
        if (ts.length === 1) setTemplateId(ts[0].id);
      })
      .catch(() => setTemplates([]));
  }, []);

  if (templates === null) return <p style={{ padding: 16 }}>Loading templates…</p>;
  if (templates.length === 0) return <p style={{ padding: 16 }}>No templates available.</p>;
  if (!templateId) {
    return (
      <div className="stack">
        <h2 className="ds-h2">Pick a story type</h2>
        {templates.map((t) => (
          <button key={t.id} className="btn" onClick={() => setTemplateId(t.id)}>
            <strong>{t.name}</strong> — {t.description}
          </button>
        ))}
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
      {mode === 'auto' ? <AutoMode templateId={templateId} /> : <GuidedMode templateId={templateId} />}
    </div>
  );
}
