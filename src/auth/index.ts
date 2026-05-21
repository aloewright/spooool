import { betterAuth } from 'better-auth';
import { sendEvent, type LoopsEnv, type LoopsResult } from '../workers/loops';

export type AuthEnv = LoopsEnv & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};

// Without this, Loops rejections (bad key, missing automation, etc.) are
// swallowed silently — the auth callback resolves and better-auth replies
// `status: true` while no email ever ships. Logging surfaces those cases
// in `wrangler tail` so the operator can see the actual API response.
function logLoopsResult(result: LoopsResult, eventName: string, to: string): void {
  if (result.ok) return;
  if (result.skipped) {
    console.warn(`[auth] loops event ${eventName} -> ${to} skipped: ${result.reason}`);
    return;
  }
  console.error(
    `[auth] loops event ${eventName} -> ${to} failed: status=${result.status} message=${result.message}`,
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
      // tells it to redirect to). We hand the link off to Loops as a
      // `password_reset` event; the lifecycle automation in the Loops
      // dashboard renders and sends the email. If LOOPS_API_KEY is unset
      // the result is silently skipped — better-auth doesn't care, and we
      // don't want a flaky upstream to swallow the user's reset.
      sendResetPassword: async ({ user, url }) => {
        const result = await sendEvent(env, {
          email: user.email,
          eventName: 'password_reset',
          eventProperties: { resetUrl: url, userId: user.id },
        });
        logLoopsResult(result, 'password_reset', user.email);
      },
    },
    // ALO-128: email verification. better-auth issues a single-use token,
    // builds the verify URL, and delegates delivery to us. We forward to
    // Loops as an `email_verification` event; the lifecycle automation in
    // Loops renders + sends the actual email. `sendOnSignUp` triggers the
    // first email automatically when a new account is created. Sensitive
    // actions (uploads) are gated separately at the API boundary by
    // checking `user.emailVerified`.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendEvent(env, {
          email: user.email,
          eventName: 'email_verification',
          eventProperties: { verifyUrl: url, userId: user.id },
        });
        logLoopsResult(result, 'email_verification', user.email);
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
