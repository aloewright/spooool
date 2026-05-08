// ALO-127: lightweight status page. Pings /api/health (already implemented in
// src/workers/health.ts) and surfaces the result. For deeper incidents we
// link out to Cloudflare's status page since spooool runs on top of it.

import { useEffect, useState } from 'react';

type Health = { ok: boolean; checkedAt: string } | { error: string };

export function Status(): JSX.Element {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/health')
      .then(async (r) => {
        const ok = r.ok;
        return { ok, checkedAt: new Date().toISOString() };
      })
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHealth({ error: err instanceof Error ? err.message : 'Unknown error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1>System status</h1>
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>API</h2>
        {health === null ? (
          <p className="ds-meta">Checking…</p>
        ) : 'error' in health ? (
          <p className="status-error">Unreachable: {health.error}</p>
        ) : health.ok ? (
          <p>
            <span aria-hidden="true">🟢</span> Operational —{' '}
            <span className="ds-meta">last checked {new Date(health.checkedAt).toLocaleTimeString()}</span>
          </p>
        ) : (
          <p>
            <span aria-hidden="true">🔴</span> Degraded
          </p>
        )}
      </section>
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Upstream</h2>
        <p className="ds-meta">
          spooool is built on Cloudflare. For network or platform incidents see{' '}
          <a href="https://www.cloudflarestatus.com" target="_blank" rel="noreferrer noopener">
            cloudflarestatus.com
          </a>
          .
        </p>
      </section>
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Updates</h2>
        <p className="ds-meta">
          Follow <a href="mailto:hello@spooool.com">hello@spooool.com</a> for direct incident
          notifications during the public beta.
        </p>
      </section>
    </main>
  );
}
