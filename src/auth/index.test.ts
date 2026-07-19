import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Capture the options passed to better-auth so we can assert that the
// password-reset / verification / post-reset-confirmation callbacks are
// wired and forward to the Cloudflare email module.
type CallbackArgs = {
  user: { id: string; email: string };
  url: string;
  token: string;
};

type CapturedOptions = {
  appName?: string;
  baseURL?: string;
  trustedOrigins?: string[];
  emailAndPassword?: {
    enabled?: boolean;
    minPasswordLength?: number;
    autoSignIn?: boolean;
    sendResetPassword?: (args: CallbackArgs) => Promise<void>;
    onPasswordReset?: (args: { user: { id: string; email: string } }) => Promise<void>;
  };
  emailVerification?: {
    sendOnSignUp?: boolean;
    autoSignInAfterVerification?: boolean;
    sendVerificationEmail?: (args: CallbackArgs) => Promise<void>;
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

const sendPasswordResetEmailSpy = vi.fn(
  async (_env: unknown, _args: unknown) => ({ ok: true as const, messageId: 'm1' }),
);
const sendVerificationEmailSpy = vi.fn(
  async (_env: unknown, _args: unknown) => ({ ok: true as const, messageId: 'm2' }),
);
const sendPasswordResetConfirmationEmailSpy = vi.fn(
  async (_env: unknown, _args: unknown) => ({ ok: true as const, messageId: 'm3' }),
);

vi.mock('../workers/email', () => ({
  sendPasswordResetEmail: (env: unknown, args: unknown) =>
    sendPasswordResetEmailSpy(env as never, args as never),
  sendVerificationEmail: (env: unknown, args: unknown) =>
    sendVerificationEmailSpy(env as never, args as never),
  sendPasswordResetConfirmationEmail: (env: unknown, args: unknown) =>
    sendPasswordResetConfirmationEmailSpy(env as never, args as never),
}));

import { createAuth } from './index';

const fakeBinding = { send: vi.fn() } as unknown as { send: () => Promise<{ messageId?: string }> };

describe('createAuth', () => {
  beforeEach(() => {
    sendPasswordResetEmailSpy.mockClear();
    sendVerificationEmailSpy.mockClear();
    sendPasswordResetConfirmationEmailSpy.mockClear();
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
    expect(captured.options?.baseURL).toBe('https://example.com');
    expect(captured.options?.emailAndPassword?.enabled).toBe(true);
    expect(captured.options?.emailAndPassword?.minPasswordLength).toBe(8);
    expect(captured.options?.emailAndPassword?.autoSignIn).toBe(true);
    expect(typeof captured.options?.emailAndPassword?.sendResetPassword).toBe('function');
    expect(typeof captured.options?.emailAndPassword?.onPasswordReset).toBe('function');
  });

  it('trusts the normalized origin configured by BETTER_AUTH_URL', () => {
    createAuth({
      DB: {} as D1Database,
      BETTER_AUTH_URL: 'https://spooool-staging.lazee.workers.dev/api/auth?source=worker',
    });

    expect(captured.options?.trustedOrigins).toEqual([
      'http://localhost:5173',
      'https://spooool.com',
      'https://www.spooool.com',
      'https://auth.pdx.software',
      'https://spooool-staging.lazee.workers.dev',
    ]);
    expect(captured.options?.baseURL).toBe('https://spooool-staging.lazee.workers.dev');
  });

  it('deduplicates BETTER_AUTH_URL when its origin is already trusted', () => {
    createAuth({
      DB: {} as D1Database,
      BETTER_AUTH_URL: 'https://spooool.com/api/auth',
    });

    expect(captured.options?.trustedOrigins).toEqual([
      'http://localhost:5173',
      'https://spooool.com',
      'https://www.spooool.com',
      'https://auth.pdx.software',
    ]);
  });

  it('trusts normalized origins from BETTER_AUTH_TRUSTED_ORIGINS', () => {
    createAuth({
      DB: {} as D1Database,
      BETTER_AUTH_URL: 'https://auth.pdx.software/api/auth',
      BETTER_AUTH_TRUSTED_ORIGINS:
        ' https://spooool-staging.lazee.workers.dev/path,https://preview.spooool.com/other ',
    });

    expect(captured.options?.trustedOrigins).toEqual([
      'http://localhost:5173',
      'https://spooool.com',
      'https://www.spooool.com',
      'https://auth.pdx.software',
      'https://spooool-staging.lazee.workers.dev',
      'https://preview.spooool.com',
    ]);
  });

  it('deduplicates configured origins and ignores invalid or non-http entries', () => {
    createAuth({
      DB: {} as D1Database,
      BETTER_AUTH_URL: 'https://spooool-staging.lazee.workers.dev/api/auth',
      BETTER_AUTH_TRUSTED_ORIGINS:
        'not a url,javascript:alert(1),https://spooool-staging.lazee.workers.dev,https://spooool.com',
    });

    expect(captured.options?.trustedOrigins).toEqual([
      'http://localhost:5173',
      'https://spooool.com',
      'https://www.spooool.com',
      'https://auth.pdx.software',
      'https://spooool-staging.lazee.workers.dev',
    ]);
  });

  it('rejects credential-bearing URLs from every configured origin source', () => {
    createAuth({
      DB: {} as D1Database,
      BETTER_AUTH_URL: 'https://user:password@spooool-staging.lazee.workers.dev/api/auth',
      BETTER_AUTH_TRUSTED_ORIGINS:
        'https://user@preview.spooool.com,https://:password@another-preview.spooool.com',
    });

    expect(captured.options?.trustedOrigins).toEqual([
      'http://localhost:5173',
      'https://spooool.com',
      'https://www.spooool.com',
      'https://auth.pdx.software',
    ]);
    expect(captured.options?.baseURL).toBeUndefined();
  });

  it.each(['', 'not a url', 'javascript:alert(1)', 'https://user:password@example.com'])(
    'does not pass an invalid BETTER_AUTH_URL to better-auth: %s',
    (url) => {
      createAuth({ DB: {} as D1Database, BETTER_AUTH_URL: url });

      expect(captured.options?.baseURL).toBeUndefined();
    },
  );

  it.each([undefined, '', 'not a url'])('does not trust an absent or invalid BETTER_AUTH_URL: %s', (url) => {
    createAuth({ DB: {} as D1Database, BETTER_AUTH_URL: url });

    expect(captured.options?.trustedOrigins).toEqual([
      'http://localhost:5173',
      'https://spooool.com',
      'https://www.spooool.com',
      'https://auth.pdx.software',
    ]);
  });

  it('sendResetPassword forwards to the email module with the reset url', async () => {
    createAuth({ DB: {} as D1Database, EMAIL: fakeBinding });
    const cb = captured.options?.emailAndPassword?.sendResetPassword;
    if (!cb) throw new Error('sendResetPassword callback missing');
    await cb({
      user: { id: 'u1', email: 'a@b.com' },
      url: 'https://x/reset?token=tok',
      token: 'tok',
    });
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ EMAIL: fakeBinding }),
      { to: 'a@b.com', url: 'https://x/reset?token=tok' },
    );
  });

  it('sendResetPassword still resolves when EMAIL binding is missing', async () => {
    sendPasswordResetEmailSpy.mockResolvedValueOnce({
      ok: false,
      skipped: true,
      reason: 'EMAIL binding not configured',
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

  it('onPasswordReset sends the post-reset confirmation email', async () => {
    createAuth({ DB: {} as D1Database, EMAIL: fakeBinding });
    const cb = captured.options?.emailAndPassword?.onPasswordReset;
    if (!cb) throw new Error('onPasswordReset callback missing');
    await cb({ user: { id: 'u1', email: 'a@b.com' } });
    expect(sendPasswordResetConfirmationEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetConfirmationEmailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ EMAIL: fakeBinding }),
      { to: 'a@b.com' },
    );
  });

  it('configures email verification with sendOnSignUp + auto sign-in', () => {
    createAuth({ DB: {} as D1Database });
    expect(captured.options?.emailVerification?.sendOnSignUp).toBe(true);
    expect(captured.options?.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(typeof captured.options?.emailVerification?.sendVerificationEmail).toBe('function');
  });

  it('sendVerificationEmail forwards to the email module with the verify url', async () => {
    createAuth({ DB: {} as D1Database, EMAIL: fakeBinding });
    const cb = captured.options?.emailVerification?.sendVerificationEmail;
    if (!cb) throw new Error('sendVerificationEmail callback missing');
    await cb({
      user: { id: 'u1', email: 'a@b.com' },
      url: 'https://x/verify?token=tok',
      token: 'tok',
    });
    expect(sendVerificationEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ EMAIL: fakeBinding }),
      { to: 'a@b.com', url: 'https://x/verify?token=tok' },
    );
  });
});
