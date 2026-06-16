import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSession } from '../lib/auth-client';

// ── Types ─────────────────────────────────────────────────────────────────────

type Impact = 'none' | 'minor' | 'major' | 'critical';
type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
type MaintenanceStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

interface Incident {
  id: string;
  title: string;
  impact: Impact;
  status: IncidentStatus;
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
  status: MaintenanceStatus;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const IMPACTS: Impact[] = ['none', 'minor', 'major', 'critical'];
const INC_STATUSES: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved'];
const MAINT_STATUSES: MaintenanceStatus[] = ['scheduled', 'in_progress', 'completed', 'cancelled'];

function fromDatetimeLocal(local: string): string {
  return new Date(local).toISOString();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminStatus(): JSX.Element {
  const { data: session, isPending } = useSession();

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceWindow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // new incident form
  const [incTitle, setIncTitle]     = useState('');
  const [incImpact, setIncImpact]   = useState<Impact>('minor');
  const [incMessage, setIncMessage] = useState('');
  const [incBusy, setIncBusy]       = useState(false);
  const [incError, setIncError]     = useState<string | null>(null);

  // per-incident update form state
  const [updateMsg, setUpdateMsg]       = useState<Record<string, string>>({});
  const [updateStatus, setUpdateStatus] = useState<Record<string, IncidentStatus>>({});
  const [updateBusy, setUpdateBusy]     = useState<Record<string, boolean>>({});

  // new maintenance form
  const [maintTitle, setMaintTitle] = useState('');
  const [maintDesc, setMaintDesc]   = useState('');
  const [maintStart, setMaintStart] = useState('');
  const [maintEnd, setMaintEnd]     = useState('');
  const [maintBusy, setMaintBusy]   = useState(false);
  const [maintError, setMaintError] = useState<string | null>(null);

  const loadIncidents = useCallback(async () => {
    const res = await fetch('/api/status/incidents?resolved=all&limit=50', { credentials: 'include' });
    if (res.status === 403) throw new Error('Forbidden — you are not an admin.');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const data = (await res.json()) as { incidents: Incident[] };
    setIncidents(data.incidents);
  }, []);

  const loadMaintenance = useCallback(async () => {
    // Upcoming maintenance is returned by the public status endpoint
    const res = await fetch('/api/status', { credentials: 'include' });
    if (!res.ok) return;
    const data = (await res.json()) as { scheduledMaintenance: MaintenanceWindow[] };
    setMaintenance(data.scheduledMaintenance ?? []);
  }, []);

  useEffect(() => {
    if (!session) return;
    setLoadError(null);
    void (async () => {
      try {
        await loadIncidents();
        await loadMaintenance();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Load failed');
      }
    })();
  }, [session, loadIncidents, loadMaintenance]);

  const createIncident = async (): Promise<void> => {
    if (!incTitle.trim() || !incMessage.trim()) return;
    setIncBusy(true);
    setIncError(null);
    try {
      const res = await fetch('/api/admin/status/incidents', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: incTitle.trim(), impact: incImpact, message: incMessage.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setIncTitle('');
      setIncMessage('');
      await loadIncidents();
    } catch (err) {
      setIncError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setIncBusy(false);
    }
  };

  const postUpdate = async (incidentId: string): Promise<void> => {
    const msg = (updateMsg[incidentId] ?? '').trim();
    const st = updateStatus[incidentId] ?? 'monitoring';
    if (!msg) return;
    setUpdateBusy((prev) => ({ ...prev, [incidentId]: true }));
    try {
      const res = await fetch(`/api/admin/status/incidents/${incidentId}/updates`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg, status: st }),
      });
      // Only clear the typed message once the update is persisted — otherwise a
      // failed request silently discards what the admin wrote.
      if (!res.ok) throw new Error(`Status ${res.status}`);
      setUpdateMsg((prev) => ({ ...prev, [incidentId]: '' }));
      await loadIncidents();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to post update');
    } finally {
      setUpdateBusy((prev) => ({ ...prev, [incidentId]: false }));
    }
  };

  const resolveIncident = async (incidentId: string): Promise<void> => {
    await fetch(`/api/admin/status/incidents/${incidentId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    await loadIncidents();
  };

  const createMaintenance = async (): Promise<void> => {
    if (!maintTitle.trim() || !maintStart || !maintEnd) return;
    setMaintBusy(true);
    setMaintError(null);
    try {
      const res = await fetch('/api/admin/status/maintenance', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: maintTitle.trim(),
          description: maintDesc.trim(),
          scheduled_start: fromDatetimeLocal(maintStart),
          scheduled_end:   fromDatetimeLocal(maintEnd),
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setMaintTitle('');
      setMaintDesc('');
      setMaintStart('');
      setMaintEnd('');
      await loadMaintenance();
    } catch (err) {
      setMaintError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setMaintBusy(false);
    }
  };

  const updateMaintenanceStatus = async (id: string, status: MaintenanceStatus): Promise<void> => {
    await fetch(`/api/admin/status/maintenance/${id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await loadMaintenance();
  };

  if (isPending) {
    return <main className="app-main stack"><p className="ds-empty">Loading…</p></main>;
  }
  if (!session) {
    return <main className="app-main stack"><p className="ds-empty">Sign in required.</p></main>;
  }

  const activeIncidents   = incidents.filter((i) => i.status !== 'resolved');
  const resolvedIncidents = incidents.filter((i) => i.status === 'resolved');

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">Status management</h1>
        <p className="ds-lede">Create and update incidents and maintenance windows.</p>
      </header>

      {loadError && <p className="status-error">{loadError}</p>}

      {/* Create incident */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Create Incident</h2>
        <div className="stack-sm" style={{ maxWidth: 560 }}>
          <input
            className="input"
            placeholder="Incident title"
            value={incTitle}
            onChange={(e) => setIncTitle(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <label className="ds-meta" htmlFor="inc-impact">Impact:</label>
            <select
              id="inc-impact"
              className="input input--sm"
              value={incImpact}
              onChange={(e) => setIncImpact(e.target.value as Impact)}
            >
              {IMPACTS.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <textarea
            className="input"
            placeholder="Initial update message"
            rows={3}
            value={incMessage}
            onChange={(e) => setIncMessage(e.target.value)}
            style={{ resize: 'vertical' }}
          />
          {incError && <p className="status-error">{incError}</p>}
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={incBusy || !incTitle.trim() || !incMessage.trim()}
            onClick={() => void createIncident()}
          >
            {incBusy ? 'Creating…' : 'Create Incident'}
          </button>
        </div>
      </section>

      {/* Active incidents */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Active Incidents</h2>
        {activeIncidents.length === 0 ? (
          <p className="ds-empty">No active incidents.</p>
        ) : (
          <div className="stack-sm">
            {activeIncidents.map((inc) => (
              <div
                key={inc.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: 'var(--space-4) var(--space-5)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <span style={{ fontWeight: 700 }}>{inc.title}</span>
                  <span className="ds-meta">
                    {inc.impact} · {inc.status} · {new Date(inc.started_at).toLocaleString()}
                  </span>
                </div>
                <div className="stack-sm" style={{ marginTop: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      className="input input--sm"
                      value={updateStatus[inc.id] ?? 'monitoring'}
                      onChange={(e) => setUpdateStatus((prev) => ({ ...prev, [inc.id]: e.target.value as IncidentStatus }))}
                    >
                      {INC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input
                      className="input input--sm"
                      style={{ flex: 1, minWidth: 160 }}
                      placeholder="Update message"
                      value={updateMsg[inc.id] ?? ''}
                      onChange={(e) => setUpdateMsg((prev) => ({ ...prev, [inc.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={updateBusy[inc.id] || !(updateMsg[inc.id] ?? '').trim()}
                      onClick={() => void postUpdate(inc.id)}
                    >
                      {updateBusy[inc.id] ? 'Posting…' : 'Post update'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void resolveIncident(inc.id)}
                    >
                      Resolve
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Schedule maintenance */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Schedule Maintenance</h2>
        <div className="stack-sm" style={{ maxWidth: 560 }}>
          <input
            className="input"
            placeholder="Maintenance title"
            value={maintTitle}
            onChange={(e) => setMaintTitle(e.target.value)}
          />
          <textarea
            className="input"
            placeholder="Description (optional)"
            rows={2}
            value={maintDesc}
            onChange={(e) => setMaintDesc(e.target.value)}
            style={{ resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <label className="stack-sm" style={{ flex: 1, minWidth: 160 }}>
              <span className="ds-meta">Start</span>
              <input
                type="datetime-local"
                className="input input--sm"
                value={maintStart}
                onChange={(e) => setMaintStart(e.target.value)}
              />
            </label>
            <label className="stack-sm" style={{ flex: 1, minWidth: 160 }}>
              <span className="ds-meta">End</span>
              <input
                type="datetime-local"
                className="input input--sm"
                value={maintEnd}
                onChange={(e) => setMaintEnd(e.target.value)}
              />
            </label>
          </div>
          {maintError && <p className="status-error">{maintError}</p>}
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={maintBusy || !maintTitle.trim() || !maintStart || !maintEnd}
            onClick={() => void createMaintenance()}
          >
            {maintBusy ? 'Scheduling…' : 'Schedule Maintenance'}
          </button>
        </div>
      </section>

      {/* Maintenance windows */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Maintenance Windows</h2>
        {maintenance.length === 0 ? (
          <p className="ds-empty">No upcoming maintenance windows.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Title</th>
                <th style={{ textAlign: 'left' }}>Start</th>
                <th style={{ textAlign: 'left' }}>End</th>
                <th style={{ textAlign: 'left' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {maintenance.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td className="ds-meta">{new Date(m.scheduled_start).toLocaleString()}</td>
                  <td className="ds-meta">{new Date(m.scheduled_end).toLocaleString()}</td>
                  <td>
                    <select
                      className="input input--sm"
                      value={m.status}
                      onChange={(e) => void updateMaintenanceStatus(m.id, e.target.value as MaintenanceStatus)}
                    >
                      {MAINT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Resolved history */}
      {resolvedIncidents.length > 0 && (
        <section className="stack-sm">
          <h2 className="ds-h3" style={{ margin: 0 }}>Resolved</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Title</th>
                <th style={{ textAlign: 'left' }}>Impact</th>
                <th style={{ textAlign: 'left' }}>Started</th>
                <th style={{ textAlign: 'left' }}>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {resolvedIncidents.map((inc) => (
                <tr key={inc.id}>
                  <td>{inc.title}</td>
                  <td className="ds-meta">{inc.impact}</td>
                  <td className="ds-meta">{new Date(inc.started_at).toLocaleString()}</td>
                  <td className="ds-meta">
                    {inc.resolved_at ? new Date(inc.resolved_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
