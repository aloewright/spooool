import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : undefined,
});

export const { useSession, signIn, signUp, signOut } = authClient;

export interface AuthResponse {
  ok: boolean;
  status: number;
  error: string | null;
}

// ALO-129: thin wrappers around better-auth's request-password-reset and
// reset-password endpoints. We don't pull these off the React client because
// the path-to-object surface drifts between minor versions; calling REST
// directly keeps the contract obvious and stable.
export async function requestPasswordReset(args: {
  email: string;
  redirectTo: string;
}): Promise<AuthResponse> {
  return postAuth('/api/auth/request-password-reset', args);
}

export async function resetPassword(args: {
  token: string;
  newPassword: string;
}): Promise<AuthResponse> {
  return postAuth('/api/auth/reset-password', args);
}

async function postAuth(path: string, body: unknown): Promise<AuthResponse> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
  if (res.ok) return { ok: true, status: res.status, error: null };
  let message = `Request failed (${res.status})`;
  try {
    const data = (await res.json()) as { message?: string; error?: string } | null;
    message = data?.message ?? data?.error ?? message;
  } catch {
    // body wasn't JSON — keep the status-based fallback message
  }
  return { ok: false, status: res.status, error: message };
}
