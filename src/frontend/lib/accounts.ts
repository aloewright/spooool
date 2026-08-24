// Thin fetch wrappers around better-auth's account-management endpoints.
// Extracted here so ConnectedAccounts can be unit-tested without a DOM.

export interface ConnectedAccount {
  id: string;
  accountId: string;
  providerId: string;
  createdAt: string | number;
  scopes?: string[];
}

export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const r = await fetch('/api/auth/list-accounts', { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`Failed to load connected accounts (${r.status})`);
  const data = (await r.json()) as ConnectedAccount[] | { accounts?: ConnectedAccount[] };
  if (Array.isArray(data)) return data;
  return data.accounts ?? [];
}

export async function unlinkAccount(providerId: string, accountId: string): Promise<void> {
  const r = await fetch('/api/auth/unlink-account', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, accountId }),
  });
  if (!r.ok) throw new Error(await readError(r, 'Could not disconnect account'));
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string } | null;
    return data?.message ?? data?.error ?? fallback;
  } catch {
    return fallback;
  }
}
