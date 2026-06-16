import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSession } from '../lib/auth-client';

type StatusFilter = 'open' | 'actioned' | 'dismissed' | 'all';

interface ModerationReport {
  latestReportId: string;
  targetType: 'video' | 'comment';
  targetId: string;
  reason: string;
  status: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  reporter: string | null;
  targetOwnerId: string | null;
  targetPreview: string | null;
}

const STATUS_OPTIONS: StatusFilter[] = ['open', 'actioned', 'dismissed', 'all'];
const ACTIONS: Array<'approve' | 'hide' | 'ban' | 'dismiss'> = [
  'approve',
  'hide',
  'ban',
  'dismiss',
];

export function AdminModeration(): JSX.Element {
  const { data: session, isPending } = useSession();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [reports, setReports] = useState<ModerationReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setReports(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/moderation?status=${status}&limit=50`, {
        credentials: 'include',
      });
      if (res.status === 403) {
        setError('Forbidden — you are not an admin.');
        setReports([]);
        return;
      }
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data = (await res.json()) as { reports: ModerationReport[] };
      setReports(data.reports);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [status]);

  useEffect(() => {
    if (!session) return;
    void load();
  }, [load, session]);

  const allKeys = useMemo(
    () => (reports ?? []).map((r) => r.latestReportId),
    [reports],
  );

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected((prev) => (prev.size === allKeys.length ? new Set() : new Set(allKeys)));
  };

  const apply = async (action: 'approve' | 'hide' | 'ban' | 'dismiss'): Promise<void> => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const ids = [...selected];
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/admin/moderation/${id}/decision`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          }),
        ),
      );
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Sign in required.</p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">Moderation queue</h1>
        <p className="ds-lede">Internal admin tool. Decisions are audit-logged.</p>
      </header>

      <section className="stack-sm">
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === status ? 'btn btn--secondary btn--sm' : 'btn btn--ghost btn--sm'}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="ds-meta">
            {selected.size} selected
          </span>
          {ACTIONS.map((a) => (
            <button
              key={a}
              type="button"
              disabled={selected.size === 0 || busy}
              className="btn btn--ghost btn--sm"
              onClick={() => void apply(a)}
            >
              {a}
            </button>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </section>

      {error && <p className="status-error">{error}</p>}

      {reports === null ? (
        <p className="ds-empty">Loading reports…</p>
      ) : reports.length === 0 ? (
        <p className="ds-empty">No reports for this filter.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  onChange={toggleAll}
                  checked={selected.size === allKeys.length && allKeys.length > 0}
                />
              </th>
              <th style={{ textAlign: 'left' }}>Target</th>
              <th style={{ textAlign: 'left' }}>Reason</th>
              <th style={{ textAlign: 'left' }}>Reports</th>
              <th style={{ textAlign: 'left' }}>Reporter (latest)</th>
              <th style={{ textAlign: 'left' }}>First / last seen</th>
              <th style={{ textAlign: 'left' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.latestReportId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.targetId}`}
                    checked={selected.has(r.latestReportId)}
                    onChange={() => toggle(r.latestReportId)}
                  />
                </td>
                <td>
                  <code>{r.targetType}</code> {r.targetId}
                  {r.targetPreview && (
                    <div className="ds-meta" style={{ maxWidth: 320 }}>
                      {r.targetPreview.slice(0, 120)}
                    </div>
                  )}
                </td>
                <td>{r.reason}</td>
                <td>{r.count}</td>
                <td>{r.reporter ?? '—'}</td>
                <td>
                  <div className="ds-meta">{r.firstSeen}</div>
                  <div className="ds-meta">{r.lastSeen}</div>
                </td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
