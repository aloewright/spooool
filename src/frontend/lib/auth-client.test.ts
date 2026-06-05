import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock better-auth/react before importing auth-client, as auth-client
// imports from it at module level.
vi.mock('better-auth/react', () => ({
  createAuthClient: vi.fn(() => ({
    useSession: vi.fn(),
    signIn: { social: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
  })),
}));

import { requestPasswordReset, resetPassword } from './auth-client';

// ── Shared fetch stub ──────────────────────────────────────────────────────────

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── requestPasswordReset ───────────────────────────────────────────────────────

describe('requestPasswordReset', () => {
  it('POSTs email + redirectTo as JSON to /api/auth/request-password-reset', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await requestPasswordReset({ email: 'user@example.com', redirectTo: '/reset' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/request-password-reset');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.email).toBe('user@example.com');
    expect(body.redirectTo).toBe('/reset');
  });

  it('does NOT include x-captcha-response header when captchaToken is absent', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await requestPasswordReset({ email: 'a@b.com', redirectTo: '/' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-captcha-response']).toBeUndefined();
  });

  it('sends x-captcha-response header when captchaToken is provided', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await requestPasswordReset({
      email: 'a@b.com',
      redirectTo: '/',
      captchaToken: 'cf-token-abc123',
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-captcha-response']).toBe('cf-token-abc123');
  });

  it('does NOT include captchaToken in the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await requestPasswordReset({
      email: 'a@b.com',
      redirectTo: '/',
      captchaToken: 'cf-token-xyz',
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.captchaToken).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(['email', 'redirectTo']);
  });

  it('returns ok:true and no error on 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await requestPasswordReset({ email: 'a@b.com', redirectTo: '/' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
  });

  it('returns ok:false and error message on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Email not found' }), { status: 404 }),
    );
    const result = await requestPasswordReset({ email: 'no@one.com', redirectTo: '/' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe('Email not found');
  });

  it('falls back to the error field when message is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
    );
    const result = await requestPasswordReset({ email: 'a@b.com', redirectTo: '/' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('rate limited');
  });

  it('falls back to status-based message when body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }));
    const result = await requestPasswordReset({ email: 'a@b.com', redirectTo: '/' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it('returns ok:false with status 0 and error message on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await requestPasswordReset({ email: 'a@b.com', redirectTo: '/' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe('Failed to fetch');
  });

  it('always sends content-type: application/json', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await requestPasswordReset({ email: 'a@b.com', redirectTo: '/', captchaToken: 'tok' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  it('uses credentials: same-origin', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await requestPasswordReset({ email: 'a@b.com', redirectTo: '/' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init as RequestInit).credentials).toBe('same-origin');
  });
});

// ── resetPassword ──────────────────────────────────────────────────────────────

describe('resetPassword', () => {
  it('POSTs token + newPassword as JSON to /api/auth/reset-password', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await resetPassword({ token: 'reset-tok', newPassword: 'hunter2!' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/reset-password');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.token).toBe('reset-tok');
    expect(body.newPassword).toBe('hunter2!');
  });

  it('does NOT include x-captcha-response header when captchaToken is absent', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await resetPassword({ token: 't', newPassword: 'p@ssw0rd' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-captcha-response']).toBeUndefined();
  });

  it('sends x-captcha-response header when captchaToken is provided', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await resetPassword({
      token: 'tok',
      newPassword: 'newp@ss',
      captchaToken: 'ts-challenge-response',
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-captcha-response']).toBe('ts-challenge-response');
  });

  it('does NOT include captchaToken in the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await resetPassword({ token: 'tok', newPassword: 'pass', captchaToken: 'cf' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.captchaToken).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(['newPassword', 'token']);
  });

  it('returns ok:true on success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await resetPassword({ token: 't', newPassword: 'p' });
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it('returns ok:false and surfaced message on 400', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Invalid or expired token' }), { status: 400 }),
    );
    const result = await resetPassword({ token: 'bad', newPassword: 'p@ss' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid or expired token');
  });

  it('returns ok:false with status 0 on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network gone'));
    const result = await resetPassword({ token: 't', newPassword: 'p' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe('network gone');
  });

  // Boundary: captchaToken is an empty string — should NOT add the header
  // (empty string is falsy in JS, so the guard `if (captchaToken)` skips it)
  it('does not add x-captcha-response for empty string captchaToken', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await resetPassword({ token: 't', newPassword: 'p', captchaToken: '' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-captcha-response']).toBeUndefined();
  });
});
