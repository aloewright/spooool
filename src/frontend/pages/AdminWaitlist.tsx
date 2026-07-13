import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../lib/auth-client';

interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  source: string;
  created_at: string;
  invited_at?: string | null;
}

interface WaitlistResponse {
  page: number;
  limit: number;
  total: number;
  entries: WaitlistEntry[];
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminWaitlist(): JSX.Element {
  const { data: session, isPending } = useSession();
  const [data, setData] = useState<WaitlistResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState<Set<string>>(new Set());
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const load = useCallback((p: number): void => {
    setLoading(true);
    setError(null);
    void fetch(`/api/admin/waitlist?page=${p}&limit=50`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as WaitlistResponse;
      })
      .then((d) => {
        setData(d);
        setPage(p);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isPending && session?.user) load(1);
  }, [isPending, session?.user, load]);

  const sendInvite = useCallback(async (entry: WaitlistEntry): Promise<void> => {
    setInviting((prev) => new Set(prev).add(entry.id));
    try {
      const res = await fetch(`/api/admin/waitlist/${entry.id}/invite`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setInvited((prev) => new Set(prev).add(entry.id));
    } catch (err: unknown) {
      alert(`Invite failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInviting((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  }, []);

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-meta">Loading…</p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-4)' }}>
        <span className="ds-label">Admin</span>
        <h1 className="ds-h2">Waitlist</h1>
        {data && (
          <p className="ds-meta">
            {data.total} {data.total === 1 ? 'person' : 'people'} on the waitlist
          </p>
        )}
      </div>

      {error && <p className="status-error">{error}</p>}

      {loading && !data && <p className="ds-meta">Loading…</p>}

      {data && (
        <>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 'var(--text-sm)',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Email</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Name</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Source</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Signed up</th>
                  <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Invited</th>
                  <th style={{ padding: 'var(--space-3)' }} />
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => {
                  const isInvited = invited.has(entry.id) || !!entry.invited_at;
                  return (
                    <tr
                      key={entry.id}
                      style={{ borderBottom: '1px solid var(--border)' }}
                    >
                      <td style={{ padding: 'var(--space-3)', fontWeight: 600 }}>
                        {entry.email}
                      </td>
                      <td style={{ padding: 'var(--space-3)', color: 'var(--text-muted)' }}>
                        {entry.name ?? '—'}
                      </td>
                      <td style={{ padding: 'var(--space-3)', color: 'var(--text-muted)' }}>
                        {entry.source}
                      </td>
                      <td style={{ padding: 'var(--space-3)', color: 'var(--text-muted)' }}>
                        {fmt(entry.created_at)}
                      </td>
                      <td style={{ padding: 'var(--space-3)', color: 'var(--text-muted)' }}>
                        {entry.invited_at
                          ? fmt(entry.invited_at)
                          : invited.has(entry.id)
                            ? 'Just now'
                            : '—'}
                      </td>
                      <td style={{ padding: 'var(--space-3)', textAlign: 'right' }}>
                        {isInvited ? (
                          <span className="ds-meta" style={{ color: 'var(--text-muted)' }}>
                            Invited
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={inviting.has(entry.id)}
                            onClick={() => void sendInvite(entry)}
                          >
                            {inviting.has(entry.id) ? 'Sending…' : 'Send invite'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {data.entries.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
                      <p className="ds-empty">No one on the waitlist yet.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data.total > data.limit && (
            <div className="row" style={{ justifyContent: 'center', gap: 'var(--space-3)' }}>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={page <= 1 || loading}
                onClick={() => load(page - 1)}
              >
                Previous
              </button>
              <span className="ds-meta">
                Page {page} of {Math.ceil(data.total / data.limit)}
              </span>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={page >= Math.ceil(data.total / data.limit) || loading}
                onClick={() => load(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
