import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Env } from "./env";

// Derives the auth mount from the prefix marker set by stripAppBasePrefix
// (src/index.ts). Every createAuth caller must pass this so cookie names and
// paths agree across handlers.
export function authBaseFromRequest(req: Request): { origin: string; prefix: string } | undefined {
  const prefix = req.headers.get("x-app-base");
  if (!prefix) return undefined;
  return { origin: new URL(req.url).origin, prefix };
}

// authBase override: the worker passes the request's origin + base prefix
// when the app is served via spooool.com/studio, so OAuth redirect URIs and
// callback links stay on the origin (and path prefix) the user is on.
export function createAuth(env: Env, authBase?: { origin: string; prefix: string }) {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.users,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    secondaryStorage: {
      get: async (key) => env.KV.get(key),
      set: async (key, value, ttl) =>
        env.KV.put(key, value, ttl ? { expirationTtl: ttl } : undefined),
      delete: async (key) => env.KV.delete(key),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL:
      authBase?.origin ??
      (env as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL ??
      (env.ENV === "prod" ? "https://bookgenerators.com" : "http://localhost:5173"),
    basePath: authBase ? `${authBase.prefix}/api/auth` : "/api/auth",
    // On the /studio mount the host (spooool.com) runs its own Better Auth
    // with the default cookie names at Path=/. Prefix and path-scope our
    // cookies there so the two apps' sessions can't collide or leak into
    // each other's routes.
    advanced: authBase
      ? {
          cookiePrefix: "book-cook",
          defaultCookieAttributes: { path: authBase.prefix },
        }
      : undefined,
    trustedOrigins: [
      "https://book-cook.com",
      "https://www.book-cook.com",
      // The spooool.com/studio vanity route lands here; trust its origin so
      // auth requests initiated from that entry point pass the CSRF check.
      "https://spooool.com",
      "https://www.spooool.com",
      "https://bookgenerators.com",
      "https://bookgenerators-web.lazee.workers.dev",
      ...Array.from({ length: 20 }, (_, i) => `http://localhost:${5173 + i}`),
    ],
    emailAndPassword: { enabled: true, autoSignIn: true },
    socialProviders: {
      // Each serving origin needs its callback registered on the Google
      // OAuth client: https://book-cook.com/api/auth/callback/google and
      // https://spooool.com/studio/api/auth/callback/google.
      google: {
        clientId: (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID ?? "",
        clientSecret: (env as { GOOGLE_CLIENT_SECRET?: string }).GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    user: {
      additionalFields: {
        plan: { type: "string", required: false, defaultValue: "pro", input: false },
        phase: {
          type: "string",
          required: false,
          defaultValue: "chassis",
          input: false,
        },
        daily_budget_cents: {
          type: "number",
          required: false,
          defaultValue: 5000,
          input: false,
        },
      },
    },
  });
}
