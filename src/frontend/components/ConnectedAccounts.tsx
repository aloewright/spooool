import { useCallback, useEffect, useState } from 'react';
import { useSession, signIn } from '../lib/auth-client';
import { listConnectedAccounts, unlinkAccount, type ConnectedAccount } from '../lib/accounts';

const PROVIDERS: { id: 'google' | 'github'; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
];

export function ConnectedAccounts(): JSX.Element | null {
  const { data: session } = useSession();
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setAccounts(await listConnectedAccounts());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connected accounts');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void reload();
  }, [session, reload]);

  if (!session) return null;

  const connectedIds = new Set(accounts?.map((a) => a.providerId) ?? []);

  async function handleUnlink(provider: 'google' | 'github'): Promise<void> {
    const account = accounts?.find((a) => a.providerId === provider);
    if (!account) return;
    setBusy(provider);
    try {
      await unlinkAccount(provider, account.accountId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect account');
    } finally {
      setBusy(null);
    }
  }

  async function handleLink(provider: 'google' | 'github'): Promise<void> {
    setBusy(provider);
    const { error: linkError } = await signIn.social({
      provider,
      callbackURL: `${window.location.origin}/account-settings`,
    });
    // On success better-auth redirects; if we're still here it errored.
    setBusy(null);
    if (linkError) setError(linkError.message ?? `Failed to connect ${provider}`);
  }

  return (
    <section className="stack-sm" aria-label="Connected accounts">
      <span className="ds-label">Connected accounts</span>
      <p className="ds-meta">
        Link social accounts so you can sign in with Google or GitHub. If you have no password set,
        keep at least one social account connected.
      </p>

      {error ? <p className="status-error">{error}</p> : null}

      {accounts === null ? (
        <p className="ds-empty">Loading…</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {PROVIDERS.map(({ id, label }) => {
            const connected = connectedIds.has(id);
            const account = accounts.find((a) => a.providerId === id);
            return (
              <li
                key={id}
                className="card"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                }}
              >
                <div className="stack-xs" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{label}</div>
                  {connected && account ? (
                    <div className="ds-meta" style={{ color: 'var(--color-success, green)' }}>
                      Connected
                      {account.accountId ? ` · ${account.accountId}` : ''}
                    </div>
                  ) : (
                    <div className="ds-meta">Not connected</div>
                  )}
                </div>
                {connected ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy !== null}
                    onClick={() => void handleUnlink(id)}
                  >
                    {busy === id ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={busy !== null}
                    onClick={() => void handleLink(id)}
                  >
                    {busy === id ? 'Redirecting…' : 'Connect'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
