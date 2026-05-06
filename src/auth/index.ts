import { betterAuth } from 'better-auth';
import { sendEvent, type LoopsEnv } from '../workers/loops';

export type AuthEnv = LoopsEnv & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};

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
      // tells it to redirect to). We hand the link off to Loops; if Loops
      // is unconfigured the result is silently skipped — better-auth
      // doesn't care, and we don't want a flaky upstream to swallow the
      // user's reset.
      sendResetPassword: async ({ user, url }) => {
        await sendEvent(env, {
          email: user.email,
          eventName: 'password_reset',
          eventProperties: { resetUrl: url, userId: user.id },
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
