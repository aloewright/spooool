// ALO-133: pure helpers + fetch wrappers around better-auth's built-in
// list/revoke session endpoints. Extracted from <ActiveSessions> so the
// formatting and HTTP shape are unit-testable without a DOM.

export interface SessionRow {
  id: string;
  token: string;
  expiresAt: string | number;
  createdAt: string | number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function formatDate(value: string | number | null | undefined): string {
  if (value == null) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toUTCString();
}

export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const paren = /\(([^)]+)\)/.exec(ua)?.[1];
  const browser = /(?:Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/.exec(ua)?.[0];
  if (paren && browser) return `${browser} · ${paren}`;
  return paren ?? browser ?? ua.slice(0, 80);
}

export async function listSessions(): Promise<SessionRow[]> {
  const r = await fetch('/api/auth/list-sessions', { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`List sessions failed (${r.status})`);
  const data = (await r.json()) as SessionRow[] | { sessions?: SessionRow[] };
  if (Array.isArray(data)) return data;
  return data.sessions ?? [];
}

export async function revokeSession(token: string): Promise<void> {
  const r = await fetch('/api/auth/revoke-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!r.ok) throw new Error(await readError(r, 'Could not revoke session'));
}

export async function revokeOtherSessions(): Promise<void> {
  const r = await fetch('/api/auth/revoke-other-sessions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
  });
  if (!r.ok) throw new Error(await readError(r, 'Could not revoke other sessions'));
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string } | null;
    return data?.message ?? data?.error ?? fallback;
  } catch {
    return fallback;
  }
}
