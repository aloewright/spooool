import { useEffect, useState } from 'react';

type WaitlistEntry = {
  id: string;
  email: string;
  name: string | null;
  source: string;
  created_at: string;
  invited_at: string | null;
};

type ListResponse = {
  page: number;
  limit: number;
  total: number;
  entries: WaitlistEntry[];
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminWaitlist(): JSX.Element {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [inviting, setInviting] = useState<Set<string>>(new Set());
  const [inviteResults, setInviteResults] = useState<Record<string, 'ok' | 'skipped' | 'error'>>({});

  const load = (p: number): void => {
    setError(null);
    void fetch(`/api/admin/waitlist?page=${p}&limit=50`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<ListResponse>;
      })
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load');
      });
  };

  useEffect(() => {
    load(page);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const invite = async (entry: WaitlistEntry): Promise<void> => {
    setInviting((prev) => new Set(prev).add(entry.id));
    try {
      const res = await fetch(`/api/admin/waitlist/${entry.id}/invite`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({})) as { ok?: boolean; skipped?: boolean; error?: string };
      if (!res.ok) {
        setInviteResults((prev) => ({ ...prev, [entry.id]: 'error' }));
        console.error('[admin-waitlist] invite failed', body.error);
        return;
      }
      setInviteResults((prev) => ({
        ...prev,
        [entry.id]: body.skipped ? 'skipped' : 'ok',
      }));
      // Optimistically mark as invited in the local list
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          entries: prev.entries.map((e) =>
            e.id === entry.id ? { ...e, invited_at: new Date().toISOString() } : e,
          ),
        };
      });
    } finally {
      setInviting((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  };

  const totalPages = data ? Math.ceil(data.total / 50) : 1;
  const invited = data?.entries.filter((e) => e.invited_at).length ?? 0;
  const total = data?.total ?? 0;

  return (
    <main className="app-main stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-6)' }}>
        <span className="ds-label">Admin</span>
        <h1 className="ds-h2">Waitlist</h1>
        {data && (
          <p className="ds-meta">
            {total} total · {invited} invited on this page
          </p>
        )}
      </div>

      {error && <p className="status-error">{error}</p>}

      {data && data.entries.length === 0 && (
        <p className="ds-empty">No waitlist entries yet.</p>
      )}

      {data && data.entries.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {(['Name', 'Email', 'Source', 'Joined', 'Status', ''] as const).map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: 'var(--space-2) var(--space-3)',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry, i) => {
                const result = inviteResults[entry.id];
                return (
                  <tr
                    key={entry.id}
                    style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}
                  >
                    <td style={{ padding: 'var(--space-2) var(--space-3)' }}>
                      {entry.name ?? <span className="ds-meta">—</span>}
                    </td>
                    <td style={{ padding: 'var(--space-2) var(--space-3)' }}>{entry.email}</td>
                    <td style={{ padding: 'var(--space-2) var(--space-3)' }}>
                      <span className="ds-meta">{entry.source}</span>
                    </td>
                    <td style={{ padding: 'var(--space-2) var(--space-3)', whiteSpace: 'nowrap' }}>
                      <span className="ds-meta">{fmt(entry.created_at)}</span>
                    </td>
                    <td style={{ padding: 'var(--space-2) var(--space-3)', whiteSpace: 'nowrap' }}>
                      {entry.invited_at ? (
                        <span style={{ color: 'oklch(0.55 0.14 145)', fontWeight: 600 }}>
                          Invited {fmt(entry.invited_at)}
                        </span>
                      ) : (
                        <span className="ds-meta">Waiting</span>
                      )}
                    </td>
                    <td style={{ padding: 'var(--space-2) var(--space-3)' }}>
                      {result === 'ok' && (
                        <span style={{ color: 'oklch(0.55 0.14 145)', fontWeight: 600 }}>
                          Sent ✓
                        </span>
                      )}
                      {result === 'skipped' && (
                        <span className="ds-meta">Email skipped (no binding)</span>
                      )}
                      {result === 'error' && (
                        <span className="status-error">Failed — check logs</span>
                      )}
                      {!result && !entry.invited_at && (
                        <button
                          type="button"
                          className="btn btn--sm btn--secondary"
                          disabled={inviting.has(entry.id)}
                          onClick={() => void invite(entry)}
                        >
                          {inviting.has(entry.id) ? 'Sending…' : 'Invite'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Prev
          </button>
          <span className="ds-meta">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </main>
  );
}
