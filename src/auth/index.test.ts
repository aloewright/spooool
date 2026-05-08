import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Capture the options passed to better-auth so we can assert that the
// password-reset and verification callbacks are wired and forward to Resend.
type CapturedOptions = {
  appName?: string;
  socialProviders?: Record<string, { clientId: string; clientSecret: string }>;
  emailAndPassword?: {
    enabled?: boolean;
    minPasswordLength?: number;
    autoSignIn?: boolean;
    sendResetPassword?: (args: {
      user: { id: string; email: string };
      url: string;
      token: string;
    }) => Promise<void>;
  };
  emailVerification?: {
    sendOnSignUp?: boolean;
    autoSignInAfterVerification?: boolean;
    sendVerificationEmail?: (args: {
      user: { id: string; email: string };
      url: string;
      token: string;
    }) => Promise<void>;
  };
};

const captured: { options?: CapturedOptions } = {};
const betterAuthSpy = vi.fn((options: CapturedOptions) => {
  captured.options = options;
  return { __mock: true };
});

vi.mock('better-auth', () => ({
  betterAuth: (options: CapturedOptions) => betterAuthSpy(options),
}));

const sendLifecycleEmailSpy = vi.fn<(env: unknown, to: string, msg: unknown) => Promise<unknown>>(
  async () => ({ ok: true, status: 200 }),
);
vi.mock('../workers/resend', () => ({
  sendLifecycleEmail: (env: unknown, to: string, msg: unknown) =>
    sendLifecycleEmailSpy(env, to, msg),
}));

import { createAuth } from './index';

describe('createAuth', () => {
  beforeEach(() => {
    sendLifecycleEmailSpy.mockClear();
    betterAuthSpy.mockClear();
    captured.options = undefined;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes app config and email-and-password defaults to better-auth', () => {
    createAuth({
      DB: {} as D1Database,
      BETTER_AUTH_SECRET: 's',
      BETTER_AUTH_URL: 'https://example.com',
    });
    expect(betterAuthSpy).toHaveBeenCalledTimes(1);
    expect(captured.options?.appName).toBe('spooool');
    expect(captured.options?.emailAndPassword?.enabled).toBe(true);
    expect(captured.options?.emailAndPassword?.minPasswordLength).toBe(8);
    expect(captured.options?.emailAndPassword?.autoSignIn).toBe(true);
    expect(typeof captured.options?.emailAndPassword?.sendResetPassword).toBe('function');
  });

  it('sendResetPassword forwards to Resend with the reset url', async () => {
    createAuth({
      DB: {} as D1Database,
      RESEND_API_KEY: 'k',
    });
    const cb = captured.options?.emailAndPassword?.sendResetPassword;
    if (!cb) throw new Error('sendResetPassword callback missing');
    await cb({
      user: { id: 'u1', email: 'a@b.com' },
      url: 'https://x/reset?token=tok',
      token: 'tok',
    });
    expect(sendLifecycleEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendLifecycleEmailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ RESEND_API_KEY: 'k' }),
      'a@b.com',
      { kind: 'password_reset', resetUrl: 'https://x/reset?token=tok' },
    );
  });

  it('sendResetPassword still resolves when RESEND_API_KEY is missing', async () => {
    sendLifecycleEmailSpy.mockResolvedValueOnce({
      ok: false,
      skipped: true,
      reason: 'no key',
    } as never);
    createAuth({ DB: {} as D1Database });
    const cb = captured.options?.emailAndPassword?.sendResetPassword;
    if (!cb) throw new Error('sendResetPassword callback missing');
    await expect(
      cb({
        user: { id: 'u1', email: 'a@b.com' },
        url: 'https://x/reset',
        token: 't',
      }),
    ).resolves.toBeUndefined();
  });

  it('omits socialProviders when no OAuth credentials are present', () => {
    createAuth({ DB: {} as D1Database });
    expect(captured.options?.socialProviders).toBeUndefined();
  });

  it('wires google + github when OAuth credentials are provided', () => {
    createAuth({
      DB: {} as D1Database,
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-secret',
    });
    expect(captured.options?.socialProviders).toEqual({
      google: { clientId: 'g-id', clientSecret: 'g-secret' },
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
    });
  });

  it('configures email verification with sendOnSignUp + auto sign-in', () => {
    createAuth({ DB: {} as D1Database });
    expect(captured.options?.emailVerification?.sendOnSignUp).toBe(true);
    expect(captured.options?.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(typeof captured.options?.emailVerification?.sendVerificationEmail).toBe('function');
  });

  it('sendVerificationEmail forwards to Resend with the verify url', async () => {
    createAuth({ DB: {} as D1Database, RESEND_API_KEY: 'k' });
    const cb = captured.options?.emailVerification?.sendVerificationEmail;
    if (!cb) throw new Error('sendVerificationEmail callback missing');
    await cb({
      user: { id: 'u1', email: 'a@b.com' },
      url: 'https://x/verify?token=tok',
      token: 'tok',
    });
    expect(sendLifecycleEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendLifecycleEmailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ RESEND_API_KEY: 'k' }),
      'a@b.com',
      { kind: 'email_verification', verifyUrl: 'https://x/verify?token=tok' },
    );
  });
});
