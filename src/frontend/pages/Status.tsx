import { useEffect, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

type OverallStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage';
type ComponentStatus = 'operational' | 'degraded' | 'unknown';

interface Component {
  name: string;
  status: ComponentStatus;
  latency_ms: number | null;
}

interface Incident {
  id: string;
  title: string;
  impact: 'none' | 'minor' | 'major' | 'critical';
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  started_at: string;
  resolved_at: string | null;
  updated_at: string;
}

interface MaintenanceWindow {
  id: string;
  title: string;
  description: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
}

interface StatusData {
  status: OverallStatus;
  components: Component[];
  activeIncidents: Incident[];
  scheduledMaintenance: MaintenanceWindow[];
  lastChecked: string | null;
  timestamp: string;
}

interface IncidentUpdate {
  id: string;
  message: string;
  status: string;
  created_at: string;
}

interface IncidentDetail {
  incident: Incident & { created_at: string };
  updates: IncidentUpdate[];
}

interface UptimeDay {
  date: string;
  uptime_pct: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const OVERALL_LABEL: Record<OverallStatus, string> = {
  operational:   'All Systems Operational',
  degraded:      'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage:  'Major Outage',
};

const OVERALL_COLOR: Record<OverallStatus, string> = {
  operational:   'oklch(0.55 0.14 145)',
  degraded:      'oklch(0.65 0.15 70)',
  partial_outage: 'oklch(0.65 0.15 50)',
  major_outage:  'oklch(0.55 0.15 25)',
};

const OVERALL_BG: Record<OverallStatus, string> = {
  operational:   'oklch(0.97 0.03 145)',
  degraded:      'oklch(0.97 0.04 70)',
  partial_outage: 'oklch(0.97 0.05 50)',
  major_outage:  'oklch(0.97 0.04 25)',
};

const COMP_COLOR: Record<ComponentStatus, string> = {
  operational: 'oklch(0.55 0.14 145)',
  degraded:    'oklch(0.55 0.15 25)',
  unknown:     'oklch(0.58 0 0)',
};

const IMPACT_COLOR: Record<string, string> = {
  none:     'oklch(0.58 0 0)',
  minor:    'oklch(0.65 0.15 70)',
  major:    'oklch(0.65 0.15 50)',
  critical: 'oklch(0.55 0.15 25)',
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ color }: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function UptimeBar({ days }: { days: UptimeDay[] }): JSX.Element {
  if (days.length === 0) return <span className="ds-meta">No data yet</span>;
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 28 }}>
      {days.map((d) => {
        const color =
          d.uptime_pct >= 99.9 ? 'oklch(0.55 0.14 145)' :
          d.uptime_pct >= 95   ? 'oklch(0.65 0.15 70)' :
                                  'oklch(0.55 0.15 25)';
        return (
          <div
            key={d.date}
            title={`${fmtDate(d.date + 'T00:00:00Z')}: ${d.uptime_pct}%`}
            style={{
              flex: 1,
              minWidth: 3,
              height: `${Math.max(20, d.uptime_pct * 0.28)}px`,
              background: color,
              borderRadius: 2,
            }}
          />
        );
      })}
    </div>
  );
}

function IncidentTimeline({ id }: { id: string }): JSX.Element {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || detail) return;
    void fetch(`/api/status/incidents/${id}`)
      .then((r) => r.json() as Promise<IncidentDetail>)
      .then(setDetail)
      .catch(() => {
        /* timeline is supplementary — a fetch failure shouldn't crash the page */
      });
  }, [open, id, detail]);

  return (
    <div style={{ marginTop: 'var(--space-2)' }}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft: 0 }}
      >
        {open ? 'Hide updates' : 'Show updates'}
      </button>
      {open && (
        <div className="stack-sm" style={{ marginTop: 'var(--space-2)' }}>
          {detail === null ? (
            <p className="ds-meta">Loading…</p>
          ) : detail.updates.length === 0 ? (
            <p className="ds-meta">No updates posted yet.</p>
          ) : (
            detail.updates.map((u) => (
              <div key={u.id} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 'var(--space-3)' }}>
                <p style={{ margin: 0 }}>{u.message}</p>
                <p className="ds-meta" style={{ margin: 0 }}>
                  {u.status} · {fmt(u.created_at)}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Status(): JSX.Element {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uptimeDays, setUptimeDays] = useState<UptimeDay[]>([]);
  const [history, setHistory] = useState<Incident[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = (): void => {
    void fetch('/api/status')
      .then((r) => {
        if (!r.ok) throw new Error(`Status ${r.status}`);
        return r.json() as Promise<StatusData>;
      })
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error');
      });
  };

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 60_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    void fetch('/api/status/uptime?days=90')
      .then((r) => r.json() as Promise<{ days_data: UptimeDay[] }>)
      .then((d) => setUptimeDays(d.days_data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void fetch('/api/status/incidents?resolved=true&limit=10')
      .then((r) => r.json() as Promise<{ incidents: Incident[] }>)
      .then((d) => setHistory(d.incidents))
      .catch(() => {});
  }, []);

  if (error) {
    return (
      <main className="app-main stack">
        <p className="status-error">Failed to load status: {error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  const bannerColor = OVERALL_COLOR[data.status];
  const bannerBg = OVERALL_BG[data.status];

  return (
    <main className="app-main app-main--narrow stack-lg fade-in" style={{ paddingBottom: 'var(--space-10)' }}>

      {/* Overall status banner */}
      <section
        style={{
          background: bannerBg,
          border: `1px solid ${bannerColor}`,
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-5) var(--space-6)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginTop: 'var(--space-6)',
        }}
      >
        <StatusDot color={bannerColor} />
        <div>
          <h1 className="ds-h2" style={{ margin: 0, color: bannerColor }}>
            {OVERALL_LABEL[data.status]}
          </h1>
          {data.lastChecked && (
            <p className="ds-meta" style={{ margin: 0, marginTop: 4 }}>
              Last checked {fmt(data.lastChecked)}
            </p>
          )}
        </div>
      </section>

      {/* Component status */}
      {data.components.length > 0 && (
        <section className="stack-sm">
          <h2 className="ds-h3" style={{ margin: 0 }}>Components</h2>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
            }}
          >
            {data.components.map((comp, i) => (
              <div
                key={comp.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 'var(--space-3) var(--space-4)',
                  borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                }}
              >
                <span style={{ fontWeight: 600 }}>{comp.name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  {comp.latency_ms != null && (
                    <span className="ds-meta">{comp.latency_ms}ms</span>
                  )}
                  <StatusDot color={COMP_COLOR[comp.status]} />
                  <span className="ds-meta" style={{ color: COMP_COLOR[comp.status], textTransform: 'capitalize' }}>
                    {comp.status.replace('_', ' ')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Active incidents */}
      {data.activeIncidents.length > 0 && (
        <section className="stack-sm">
          <h2 className="ds-h3" style={{ margin: 0 }}>Active Incidents</h2>
          <div className="stack-sm">
            {data.activeIncidents.map((inc) => (
              <div
                key={inc.id}
                style={{
                  border: `1px solid ${IMPACT_COLOR[inc.impact]}`,
                  borderRadius: 'var(--radius-lg)',
                  padding: 'var(--space-4) var(--space-5)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      background: IMPACT_COLOR[inc.impact],
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-pill)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {inc.impact}
                  </span>
                  <span
                    className="ds-meta"
                    style={{ textTransform: 'capitalize' }}
                  >
                    {inc.status}
                  </span>
                </div>
                <p style={{ margin: '6px 0 2px', fontWeight: 700 }}>{inc.title}</p>
                <p className="ds-meta" style={{ margin: 0 }}>Started {fmt(inc.started_at)}</p>
                <IncidentTimeline id={inc.id} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Scheduled maintenance */}
      {data.scheduledMaintenance.length > 0 && (
        <section className="stack-sm">
          <h2 className="ds-h3" style={{ margin: 0 }}>Scheduled Maintenance</h2>
          <div className="stack-sm">
            {data.scheduledMaintenance.map((m) => (
              <div
                key={m.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: 'var(--space-4) var(--space-5)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <span className="ds-meta" style={{ textTransform: 'capitalize' }}>{m.status.replace('_', ' ')}</span>
                </div>
                <p style={{ margin: '4px 0 2px', fontWeight: 700 }}>{m.title}</p>
                {m.description && <p className="ds-meta" style={{ margin: '0 0 4px' }}>{m.description}</p>}
                <p className="ds-meta" style={{ margin: 0 }}>
                  {fmt(m.scheduled_start)} → {fmt(m.scheduled_end)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 90-day uptime */}
      <section className="stack-sm">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
          <h2 className="ds-h3" style={{ margin: 0 }}>Uptime</h2>
          <span className="ds-meta">past 90 days</span>
        </div>
        <UptimeBar days={uptimeDays} />
      </section>

      {/* Incident history */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Incident History</h2>
        {history.length === 0 ? (
          <p className="ds-empty">No incidents in the past 30 days.</p>
        ) : (
          <div className="stack-sm">
            {history.map((inc) => (
              <div
                key={inc.id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: 'var(--space-3)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <StatusDot color={IMPACT_COLOR[inc.impact]} />
                  <span style={{ fontWeight: 600 }}>{inc.title}</span>
                  <span className="ds-meta" style={{ marginLeft: 'auto' }}>
                    {fmt(inc.started_at)}
                    {inc.resolved_at && ` → resolved ${fmt(inc.resolved_at)}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

    </main>
  );
}
