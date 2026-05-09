// ALO-127 — public service status page. Polls /api/health every 30s and
// renders the per-component status (DB / cache / storage). Intentionally
// minimal — when we outgrow this, swap to a hosted status page.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

type CheckStatus = 'ok' | 'fail' | 'skip';

interface Check {
  status: CheckStatus;
  latency_ms?: number;
  error?: string;
}

interface HealthReport {
  status: 'ok' | 'degraded';
  uptime_ms: number;
  version: string | null;
  timestamp: string;
  checks: { db: Check; cache: Check; storage: Check };
}

const POLL_INTERVAL_MS = 30_000;

function StatusDot({ status }: { status: CheckStatus }): JSX.Element {
  const color =
    status === 'ok' ? 'oklch(0.66 0.18 145)' : status === 'fail' ? 'var(--destructive)' : 'var(--muted-foreground)';
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: color }}
    />
  );
}

function describe(status: CheckStatus): string {
  if (status === 'ok') return 'Operational';
  if (status === 'fail') return 'Degraded';
  return 'Not configured';
}

function CheckRow({
  label,
  blurb,
  check,
}: {
  label: string;
  blurb: string;
  check: Check;
}): JSX.Element {
  return (
    <div
      className="card card--tight"
      style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 16 }}
    >
      <StatusDot status={check.status} />
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div className="ds-meta">{blurb}</div>
      </div>
      <div className="ds-meta" style={{ textAlign: 'right' }}>
        {describe(check.status)}
        {check.latency_ms !== undefined ? ` · ${check.latency_ms}ms` : ''}
      </div>
    </div>
  );
}

export function Status(): JSX.Element {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const body = (await res.json()) as HealthReport;
        if (cancelled) return;
        setReport(body);
        setLoadedAt(new Date());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch /api/health');
      }
    }
    void load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const overall = report?.status ?? null;
  const headline =
    overall === 'ok'
      ? 'All systems operational'
      : overall === 'degraded'
        ? 'Some systems are degraded'
        : 'Checking status…';

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingTop: 'var(--space-8)' }}
      >
        <span className="ds-label">Status</span>
        <h1 className="ds-h1" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          {overall ? <StatusDot status={overall === 'ok' ? 'ok' : 'fail'} /> : null}
          {headline}
        </h1>
        {loadedAt ? (
          <p className="ds-meta">Last checked {loadedAt.toLocaleTimeString()}.</p>
        ) : null}
      </section>

      {error ? <p className="status-error">{error}</p> : null}

      {report ? (
        <section className="stack-sm" aria-label="Service components">
          <CheckRow
            label="API + Database"
            blurb="Authentication, video metadata, comments, and channels."
            check={report.checks.db}
          />
          <CheckRow
            label="Cache"
            blurb="Trending feed, video metadata cache, rate limiting."
            check={report.checks.cache}
          />
          <CheckRow
            label="Video storage"
            blurb="R2 object storage for uploaded video files."
            check={report.checks.storage}
          />
        </section>
      ) : null}

      <section className="stack-sm" aria-label="Build info">
        <h2 className="ds-h3" style={{ margin: 0 }}>Build</h2>
        <p className="ds-meta">
          Version: {report?.version ?? 'unknown'}
          {report?.uptime_ms !== undefined
            ? ` · Worker uptime: ${Math.floor(report.uptime_ms / 1000)}s`
            : ''}
        </p>
        <p className="ds-meta">
          See <Link to="/help">help center</Link> for known issues, or contact{' '}
          <a href="mailto:hello@spooool.com">hello@spooool.com</a> if something looks wrong.
        </p>
      </section>
    </main>
  );
}
