// ALO-182: public status page.
//
// Lives at /status on the SPA; status.spooool.com is expected to point at
// the same Worker via DNS so the path resolves there too. Polls /api/status
// every 30s for live state.

import { useEffect, useState } from 'react';

type CheckStatus = 'ok' | 'fail' | 'skip';

interface HealthCheck {
  status: CheckStatus;
  latency_ms?: number;
  error?: string;
}

interface HealthReport {
  status: 'ok' | 'degraded';
  uptime_ms: number;
  version: string | null;
  timestamp: string;
  checks: { db: HealthCheck; cache: HealthCheck; storage: HealthCheck };
}

interface Incident {
  id: string;
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  severity: 'minor' | 'major' | 'critical';
  summary: string;
}

interface Maintenance {
  id: string;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  summary: string;
}

interface StatusReport {
  health: HealthReport;
  incidents: Incident[];
  maintenance: Maintenance[];
}

const COMPONENT_LABELS: Record<keyof HealthReport['checks'], string> = {
  db: 'Database',
  cache: 'Cache',
  storage: 'Video storage',
};

function statusDot(s: CheckStatus | 'ok' | 'degraded'): string {
  if (s === 'ok') return '🟢';
  if (s === 'skip') return '⚪';
  if (s === 'degraded' || s === 'fail') return '🔴';
  return '⚪';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function Status(): JSX.Element {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/status', { credentials: 'omit' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as StatusReport;
        if (!cancelled) {
          setReport(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section className="stack-sm">
        <h1>System status</h1>
        <p className="ds-meta">
          Live health, recent incidents, and planned maintenance for spooool.
        </p>
      </section>

      <section className="stack-sm" aria-label="Current status">
        <h2 className="ds-h3" style={{ margin: 0 }}>Current status</h2>
        {error ? (
          <p className="status-error">Could not reach status API: {error}</p>
        ) : report === null ? (
          <p className="ds-empty">Loading…</p>
        ) : (
          <div className="stack-sm">
            <p style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
              {statusDot(report.health.status)}{' '}
              {report.health.status === 'ok'
                ? 'All systems operational'
                : 'Degraded performance'}
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {(Object.keys(COMPONENT_LABELS) as (keyof HealthReport['checks'])[]).map((key) => {
                const check = report.health.checks[key];
                return (
                  <li
                    key={key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: 'var(--space-2) 0',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span>
                      {statusDot(check.status)} {COMPONENT_LABELS[key]}
                    </span>
                    <span className="ds-meta">
                      {check.status === 'ok' && check.latency_ms != null
                        ? `${check.latency_ms}ms`
                        : check.status === 'fail'
                          ? (check.error ?? 'failing')
                          : check.status}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="ds-meta">
              Last checked {formatDate(report.health.timestamp)}
              {report.health.version ? ` · build ${report.health.version}` : ''}
            </p>
          </div>
        )}
      </section>

      <section className="stack-sm" aria-label="Planned maintenance">
        <h2 className="ds-h3" style={{ margin: 0 }}>Planned maintenance</h2>
        {report?.maintenance && report.maintenance.length > 0 ? (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {report.maintenance.map((m) => (
              <li
                key={m.id}
                style={{ padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ fontWeight: 700 }}>{m.title}</div>
                <div className="ds-meta">
                  {formatDate(m.scheduledStart)} → {formatDate(m.scheduledEnd)}
                </div>
                <p style={{ marginTop: 4 }}>{m.summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ds-empty">No maintenance scheduled.</p>
        )}
      </section>

      <section className="stack-sm" aria-label="Incident history">
        <h2 className="ds-h3" style={{ margin: 0 }}>Incident history</h2>
        {report?.incidents && report.incidents.length > 0 ? (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {report.incidents.map((i) => (
              <li
                key={i.id}
                style={{ padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ fontWeight: 700 }}>
                  [{i.severity}] {i.title}
                </div>
                <div className="ds-meta">
                  {formatDate(i.startedAt)}
                  {i.resolvedAt ? ` → resolved ${formatDate(i.resolvedAt)}` : ' · ongoing'}
                </div>
                <p style={{ marginTop: 4 }}>{i.summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ds-empty">No incidents reported.</p>
        )}
      </section>
    </main>
  );
}
