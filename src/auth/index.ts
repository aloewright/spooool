import { betterAuth } from 'better-auth';
import {
  sendPasswordResetConfirmationEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  type EmailEnv,
  type EmailResult,
} from '../workers/email';

export type AuthEnv = EmailEnv & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

// Without this, send failures (unverified domain, binding misconfigured)
// are swallowed silently — the auth callback resolves and better-auth
// replies `status: true` while no email ever ships. Logging surfaces those
// cases in `wrangler tail` so the operator can see the actual response.
function logEmailResult(result: EmailResult, kind: string, to: string): void {
  if (result.ok) return;
  if (result.skipped) {
    console.warn(`[auth] email ${kind} -> ${to} skipped: ${result.reason}`);
    return;
  }
  console.error(`[auth] email ${kind} -> ${to} failed: ${result.message}`);
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
      // tells it to redirect to). We send the link directly via Cloudflare
      // Email Service. If the EMAIL binding is missing the result is a
      // silent skip — better-auth doesn't care, and we don't want a flaky
      // upstream to swallow the user's reset.
      sendResetPassword: async ({ user, url }) => {
        const result = await sendPasswordResetEmail(env, { to: user.email, url });
        logEmailResult(result, 'password_reset', user.email);
      },
      // Confirmation email after a successful reset — best-effort, runs in
      // the background-task handler when available so it doesn't block the
      // reset response.
      onPasswordReset: async ({ user }) => {
        const result = await sendPasswordResetConfirmationEmail(env, { to: user.email });
        logEmailResult(result, 'password_reset_confirmation', user.email);
      },
    },
    // ALO-128: email verification. better-auth issues a single-use token,
    // builds the verify URL, and delegates delivery to us. `sendOnSignUp`
    // triggers the first email automatically when a new account is created.
    // Sensitive actions (uploads) are gated separately at the API boundary
    // by checking `user.emailVerified`.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendVerificationEmail(env, { to: user.email, url });
        logEmailResult(result, 'email_verification', user.email);
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
    // Auto-link OAuth accounts to an existing user when the provider email
    // matches. Google and GitHub are trusted — their emails are verified by
    // the provider, so the match is safe without an extra confirmation step.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github'],
      },
    },
    trustedOrigins: [
      'http://localhost:5173',
      'https://spooool.com',
      'https://spooool.workers.dev',
    ],
  });
}
