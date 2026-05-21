import { betterAuth } from 'better-auth';
import { sendLifecycleEmail, type ResendEnv, type ResendResult } from '../workers/resend';

export type AuthEnv = ResendEnv & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};

// Without this, Resend rejections (unverified domain, sandbox key, etc.) are
// swallowed silently — the auth callback resolves and better-auth replies
// `status: true` while the email never leaves. Logging surfaces those cases
// in `wrangler tail` so the operator can see the actual API response.
function logResendResult(result: ResendResult, kind: string, to: string): void {
  if (result.ok) return;
  if (result.skipped) {
    console.warn(`[auth] lifecycle email ${kind} -> ${to} skipped: ${result.reason}`);
    return;
  }
  console.error(
    `[auth] lifecycle email ${kind} -> ${to} failed: status=${result.status} message=${result.message}`,
  );
}

export function createAuth(env: AuthEnv) {
  return betterAuth({
    appName: 'spooool',
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      // ALO-129: forgot-password handler. Better-auth issues a single-use
      // token and constructs `url` (which the client `forgetPassword` call
      // tells it to redirect to). We hand the link off to Resend; if
      // RESEND_API_KEY is unset the result is silently skipped — better-auth
      // doesn't care, and we don't want a flaky upstream to swallow the
      // user's reset.
      sendResetPassword: async ({ user, url }) => {
        const result = await sendLifecycleEmail(env, user.email, {
          kind: 'password_reset',
          resetUrl: url,
        });
        logResendResult(result, 'password_reset', user.email);
      },
    },
    // ALO-128: email verification. better-auth issues a single-use token,
    // builds the verify URL, and delegates delivery to us. We render the
    // email locally and send it via Resend. `sendOnSignUp` triggers the
    // first email automatically when a new account is created. Sensitive
    // actions (uploads) are gated separately at the API boundary by
    // checking `user.emailVerified`.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendLifecycleEmail(env, user.email, {
          kind: 'email_verification',
          verifyUrl: url,
        });
        logResendResult(result, 'email_verification', user.email);
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    trustedOrigins: [
      'http://localhost:5173',
      'https://spooool.com',
      'https://spooool.workers.dev',
    ],
  });
}
