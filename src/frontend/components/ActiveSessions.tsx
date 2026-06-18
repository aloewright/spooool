import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSession } from '../lib/auth-client';
import {
  describeUserAgent,
  formatDate,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  type SessionRow,
} from '../lib/sessions';

// ALO-133: list and revoke sessions via better-auth's built-in endpoints
// (/api/auth/list-sessions, /revoke-session, /revoke-other-sessions). The
// HTTP shape and formatting helpers live in lib/sessions.ts so we can unit
// test them without a DOM.

export function ActiveSessions(): JSX.Element | null {
  const { data: session } = useSession();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setSessions(await listSessions());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void reload();
  }, [session, reload]);

  if (!session) return null;

  const currentSessionId = session.session?.id ?? null;
  const otherCount =
    sessions != null && currentSessionId != null
      ? sessions.filter((s) => s.id !== currentSessionId).length
      : 0;

  return (
    <section className="stack-sm" aria-label="Active sessions">
      <span className="ds-label">Active sessions</span>
      <p className="ds-meta">
        Devices and browsers currently signed in to your account. Revoke a session to sign that
        device out immediately.
      </p>

      {error ? <p className="status-error">{error}</p> : null}

      {sessions === null ? (
        <p className="ds-empty">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="ds-empty">No active sessions.</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {sessions.map((row) => {
            const isCurrent = row.id === currentSessionId;
            return (
              <li
                key={row.id}
                className="card"
                style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'flex-start' }}
              >
                <div className="stack-xs" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {describeUserAgent(row.userAgent)}
                    {isCurrent ? (
                      <span className="ds-meta" style={{ marginLeft: 'var(--space-2)' }}>· This device</span>
                    ) : null}
                  </div>
                  <div className="ds-meta">
                    {row.ipAddress ?? 'Unknown IP'} · created {formatDate(row.createdAt)}
                  </div>
                  <div className="ds-meta">Expires {formatDate(row.expiresAt)}</div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy || isCurrent}
                  title={isCurrent ? 'Sign out from the header to end this session.' : undefined}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await revokeSession(row.token);
                      await reload();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {otherCount > 0 ? (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await revokeOtherSessions();
              await reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Revoking…' : `Sign out other sessions (${otherCount})`}
        </button>
      ) : null}
    </section>
  );
}
