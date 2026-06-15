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
  captchaToken?: string | null;
}): Promise<AuthResponse> {
  const { captchaToken, ...body } = args;
  return postAuth('/api/auth/request-password-reset', body, captchaToken);
}

export async function resetPassword(args: {
  token: string;
  newPassword: string;
  captchaToken?: string | null;
}): Promise<AuthResponse> {
  const { captchaToken, ...body } = args;
  return postAuth('/api/auth/reset-password', body, captchaToken);
}

export async function resendVerificationEmail(email: string): Promise<AuthResponse> {
  return postAuth('/api/auth/send-verification-email', { email });
}

async function postAuth(path: string, body: unknown, captchaToken?: string | null): Promise<AuthResponse> {
  let res: Response;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (captchaToken) {
      headers['x-captcha-response'] = captchaToken;
    }

    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
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
