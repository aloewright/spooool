import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSession } from '../lib/auth-client';

type Role = 'admin' | 'moderator';

interface RoleAssignment {
  userId: string;
  email: string | null;
  role: string;
  grantedAt: string;
  grantedBy: string | null;
}

const ROLES: Role[] = ['admin', 'moderator'];

function formatGrantedAt(raw: string): string {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return new Date(ms).toLocaleString();
}

export function AdminRoles(): JSX.Element {
  const { data: session, isPending } = useSession();
  const [assignments, setAssignments] = useState<RoleAssignment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantRole, setGrantRole] = useState<Role>('moderator');
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setAssignments(null);
    setLoadError(null);
    setForbidden(false);
    try {
      const res = await fetch('/api/admin/roles', { credentials: 'include' });
      if (res.status === 403) {
        setForbidden(true);
        setAssignments([]);
        return;
      }
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const data = (await res.json()) as { roles: RoleAssignment[] };
      setAssignments(data.roles);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void load();
  }, [load, session]);

  const onGrant = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const email = grantEmail.trim().toLowerCase();
    if (!email) return;
    setGrantBusy(true);
    setGrantError(null);
    try {
      const res = await fetch('/api/admin/roles', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role: grantRole }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Grant failed: ${res.status}`);
      }
      setGrantEmail('');
      await load();
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : 'Failed to grant role');
    } finally {
      setGrantBusy(false);
    }
  };

  const onRevoke = async (assignment: RoleAssignment): Promise<void> => {
    if (!assignment.email) return;
    const ok = window.confirm(
      `Revoke ${assignment.role} from ${assignment.email}?`,
    );
    if (!ok) return;
    const key = `${assignment.userId}:${assignment.role}`;
    setRevokingKey(key);
    setRevokeError(null);
    try {
      const params = new URLSearchParams({ email: assignment.email, role: assignment.role });
      const res = await fetch(`/api/admin/roles?${params.toString()}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Revoke failed: ${res.status}`);
      }
      await load();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke role');
    } finally {
      setRevokingKey(null);
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

  if (forbidden) {
    return (
      <main className="app-main stack">
        <p className="status-error">Forbidden — admin access required.</p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">Admin roles</h1>
        <p className="ds-lede">
          Grant or revoke admin / moderator privileges. Backed by the user_roles table —
          ADMIN_EMAILS only applies before a real admin is granted.
        </p>
      </header>

      <section className="stack-sm" aria-label="Grant role">
        <form
          onSubmit={(e) => {
            void onGrant(e);
          }}
          className="row"
          style={{ gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}
        >
          <label className="stack-sm" style={{ flex: '1 1 280px' }}>
            <span className="ds-meta">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              className="input"
              placeholder="user@example.com"
              value={grantEmail}
              onChange={(e) => setGrantEmail(e.target.value)}
              disabled={grantBusy}
            />
          </label>
          <label className="stack-sm">
            <span className="ds-meta">Role</span>
            <select
              className="input"
              value={grantRole}
              onChange={(e) => setGrantRole(e.target.value as Role)}
              disabled={grantBusy}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--secondary" disabled={grantBusy}>
            {grantBusy ? 'Granting…' : 'Grant role'}
          </button>
        </form>
        {grantError && <p className="status-error">{grantError}</p>}
      </section>

      <section className="stack-sm" aria-label="Current role assignments">
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <h2 className="ds-h3" style={{ margin: 0, flex: 1 }}>
            Current assignments
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              void load();
            }}
          >
            Refresh
          </button>
        </div>

        {loadError && <p className="status-error">{loadError}</p>}
        {revokeError && <p className="status-error">{revokeError}</p>}

        {assignments === null ? (
          <p className="ds-empty">Loading…</p>
        ) : assignments.length === 0 ? (
          <p className="ds-empty">
            No persisted role assignments yet. Bootstrap admin via ADMIN_EMAILS, then grant
            others here.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Email</th>
                <th style={{ textAlign: 'left' }}>Role</th>
                <th style={{ textAlign: 'left' }}>Granted</th>
                <th style={{ textAlign: 'left' }}>By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => {
                const key = `${a.userId}:${a.role}`;
                return (
                  <tr key={key}>
                    <td>{a.email ?? <span className="ds-meta">(unknown user)</span>}</td>
                    <td>
                      <code>{a.role}</code>
                    </td>
                    <td>
                      <span className="ds-meta">{formatGrantedAt(a.grantedAt)}</span>
                    </td>
                    <td>
                      <span className="ds-meta">{a.grantedBy ?? '—'}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          void onRevoke(a);
                        }}
                        disabled={!a.email || revokingKey === key}
                      >
                        {revokingKey === key ? 'Revoking…' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
