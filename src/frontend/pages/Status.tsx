// ALO-182: public status page (status.spooool.com).
//
// Pure read-only — fetches /api/status and renders the snapshot. Admin
// authoring (creating incidents, posting updates) is handled separately
// via /api/admin/status/* and isn't surfaced here.

import { useEffect, useState } from 'react';

type OverallStatus = 'operational' | 'degraded' | 'major_outage' | 'maintenance';
type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
type IncidentSeverity = 'minor' | 'major' | 'critical';

interface IncidentUpdate {
  id: string;
  status: IncidentStatus;
  message: string;
  created_at: string;
}

interface Incident {
  id: string;
  title: string;
  component: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  started_at: string;
  resolved_at: string | null;
  updated_at: string;
  updates: IncidentUpdate[];
}

interface MaintenanceWindow {
  id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
}

interface HealthCheck {
  status: 'ok' | 'fail' | 'skip';
  latency_ms?: number;
  error?: string;
}

interface StatusReport {
  overall: OverallStatus;
  generated_at: string;
  health: {
    status: 'ok' | 'degraded';
    uptime_ms: number;
    version: string | null;
    timestamp: string;
    checks: { db: HealthCheck; cache: HealthCheck; storage: HealthCheck };
  };
  active_incidents: Incident[];
  recent_incidents: Incident[];
  upcoming_maintenance: MaintenanceWindow[];
  recent_maintenance: MaintenanceWindow[];
}

const OVERALL_LABEL: Record<OverallStatus, string> = {
  operational: 'All systems operational',
  degraded: 'Some systems degraded',
  major_outage: 'Major outage in progress',
  maintenance: 'Scheduled maintenance in progress',
};

const OVERALL_COLOR: Record<OverallStatus, string> = {
  operational: '#16a34a',
  degraded: '#f59e0b',
  major_outage: '#dc2626',
  maintenance: '#2563eb',
};

const COMPONENT_LABEL: Record<string, string> = {
  db: 'Database',
  cache: 'Cache',
  storage: 'Object storage',
};

function fmtDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function statusBadge(label: string, color: string): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        background: `color-mix(in oklch, ${color}, transparent 80%)`,
        color,
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
        }}
      />
      {label}
    </span>
  );
}

function ComponentRow({ name, check }: { name: string; check: HealthCheck }): JSX.Element {
  const label = COMPONENT_LABEL[name] ?? name;
  if (check.status === 'skip') {
    return (
      <li className="status-row" style={rowStyle}>
        <span>{label}</span>
        {statusBadge('Not configured', '#6b7280')}
      </li>
    );
  }
  if (check.status === 'fail') {
    return (
      <li className="status-row" style={rowStyle}>
        <span>{label}</span>
        {statusBadge('Down', '#dc2626')}
      </li>
    );
  }
  return (
    <li className="status-row" style={rowStyle}>
      <span>{label}</span>
      {statusBadge('Operational', '#16a34a')}
    </li>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: 'var(--space-3) var(--space-4)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  marginBottom: 'var(--space-2)',
  listStyle: 'none',
};

const SEVERITY_COLOR: Record<IncidentSeverity, string> = {
  minor: '#f59e0b',
  major: '#ea580c',
  critical: '#dc2626',
};

function IncidentCard({ incident }: { incident: Incident }): JSX.Element {
  const sevColor = SEVERITY_COLOR[incident.severity];
  return (
    <article
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-3)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <h3 className="ds-h3" style={{ margin: 0 }}>
          {incident.title}
        </h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {statusBadge(incident.severity, sevColor)}
          {statusBadge(
            incident.status,
            incident.status === 'resolved' ? '#16a34a' : '#f59e0b',
          )}
        </div>
      </header>
      <p className="ds-meta" style={{ marginBottom: 'var(--space-2)' }}>
        {incident.component} · started {fmtDate(incident.started_at)}
        {incident.resolved_at ? ` · resolved ${fmtDate(incident.resolved_at)}` : ''}
      </p>
      {incident.updates.length === 0 ? null : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {incident.updates.map((u) => (
            <li
              key={u.id}
              style={{
                paddingLeft: 'var(--space-3)',
                borderLeft: '2px solid var(--border)',
                marginBottom: 'var(--space-2)',
              }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <strong style={{ textTransform: 'capitalize' }}>{u.status}</strong>
                <span className="ds-meta">· {fmtDate(u.created_at)}</span>
              </div>
              <p style={{ margin: '4px 0 0' }}>{u.message}</p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function MaintenanceCard({ window }: { window: MaintenanceWindow }): JSX.Element {
  return (
    <article
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-3)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <h3 className="ds-h3" style={{ margin: 0 }}>
          {window.title}
        </h3>
        {statusBadge('maintenance', '#2563eb')}
      </header>
      <p className="ds-meta" style={{ marginBottom: 'var(--space-2)' }}>
        {fmtDate(window.starts_at)} → {fmtDate(window.ends_at)}
      </p>
      {window.description ? <p style={{ margin: 0 }}>{window.description}</p> : null}
    </article>
  );
}

export function Status(): JSX.Element {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/status', { credentials: 'omit' });
        if (!res.ok) throw new Error(`Failed to load status (${res.status})`);
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
    // Poll every 60s so a long-lived tab catches a status change without
    // requiring a manual reload. Aligns with the s-maxage on /api/status.
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm" style={{ marginBottom: 'var(--space-4)' }}>
        <h1 className="ds-h1" style={{ margin: 0 }}>
          spooool status
        </h1>
        <p className="ds-meta">
          Live operational status, ongoing incidents, and planned maintenance.
        </p>
      </header>

      {error ? <p className="status-error">{error}</p> : null}

      {report === null && error === null ? (
        <p className="ds-empty">Loading…</p>
      ) : null}

      {report !== null ? (
        <>
          <section
            aria-label="Overall status"
            style={{
              padding: 'var(--space-4)',
              borderRadius: 12,
              border: `1px solid ${OVERALL_COLOR[report.overall]}`,
              background: `color-mix(in oklch, ${OVERALL_COLOR[report.overall]}, transparent 90%)`,
              marginBottom: 'var(--space-6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ fontSize: 'var(--text-xl)' }}>
              {OVERALL_LABEL[report.overall]}
            </strong>
            <span className="ds-meta">As of {fmtDate(report.generated_at)}</span>
          </section>

          <section className="stack-sm" aria-label="Components">
            <h2 className="ds-h2" style={{ margin: 0 }}>
              Components
            </h2>
            <ul style={{ padding: 0, margin: 0 }}>
              <ComponentRow name="db" check={report.health.checks.db} />
              <ComponentRow name="cache" check={report.health.checks.cache} />
              <ComponentRow name="storage" check={report.health.checks.storage} />
            </ul>
          </section>

          <section className="stack-sm" aria-label="Active incidents">
            <h2 className="ds-h2" style={{ margin: 0 }}>
              Active incidents
            </h2>
            {report.active_incidents.length === 0 ? (
              <p className="ds-empty">No active incidents.</p>
            ) : (
              report.active_incidents.map((i) => <IncidentCard key={i.id} incident={i} />)
            )}
          </section>

          <section className="stack-sm" aria-label="Planned maintenance">
            <h2 className="ds-h2" style={{ margin: 0 }}>
              Planned maintenance
            </h2>
            {report.upcoming_maintenance.length === 0 ? (
              <p className="ds-empty">No maintenance scheduled.</p>
            ) : (
              report.upcoming_maintenance.map((w) => <MaintenanceCard key={w.id} window={w} />)
            )}
          </section>

          <section className="stack-sm" aria-label="Incident history">
            <h2 className="ds-h2" style={{ margin: 0 }}>
              Recent incident history
            </h2>
            {report.recent_incidents.length === 0 ? (
              <p className="ds-empty">No incidents in the past 90 days.</p>
            ) : (
              report.recent_incidents.map((i) => <IncidentCard key={i.id} incident={i} />)
            )}
          </section>

          {report.recent_maintenance.length > 0 ? (
            <section className="stack-sm" aria-label="Recent maintenance">
              <h2 className="ds-h2" style={{ margin: 0 }}>
                Recent maintenance
              </h2>
              {report.recent_maintenance.map((w) => (
                <MaintenanceCard key={w.id} window={w} />
              ))}
            </section>
          ) : null}

          {report.health.version ? (
            <p className="ds-meta" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              Build {report.health.version}
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
