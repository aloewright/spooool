import { betterAuth } from 'better-auth';
import { sendLifecycleEmail, type ResendEnv } from '../workers/resend';

export type AuthEnv = ResendEnv & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  // ALO-120: OAuth providers. Each is enabled only when both client id and
  // secret are present; absent vars cleanly skip the provider so local dev
  // and tests don't need real credentials.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

export function createAuth(env: AuthEnv) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }

  return betterAuth({
    appName: 'spooool',
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
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
        await sendLifecycleEmail(env, user.email, {
          kind: 'password_reset',
          resetUrl: url,
        });
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
        await sendLifecycleEmail(env, user.email, {
          kind: 'email_verification',
          verifyUrl: url,
        });
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
