import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Env } from "./env";

export type AuthBase = { origin: string; prefix: string };

const STATIC_AUTH_ORIGINS = [
  "https://spooool.com",
  "https://www.spooool.com",
  "https://bookgenerators.com",
] as const;
const LOCAL_AUTH_ORIGINS = Array.from({ length: 20 }, (_, i) => `http://localhost:${5173 + i}`);
const EDITOR_WORKER_HOST = "editor.lazee.workers.dev";
const EDITOR_PREVIEW_HOST_SUFFIX = `-${EDITOR_WORKER_HOST}`;

function isTrustedRequestOrigin(url: URL): boolean {
  if ((STATIC_AUTH_ORIGINS as readonly string[]).includes(url.origin)) return true;
  if (LOCAL_AUTH_ORIGINS.includes(url.origin)) return true;
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    (url.hostname === EDITOR_WORKER_HOST || url.hostname.endsWith(EDITOR_PREVIEW_HOST_SUFFIX))
  );
}

// Derives the auth origin and mount from the request after stripAppBasePrefix
// has sanitized the prefix marker. An empty prefix is the local/direct Worker
// root mount; every caller passes this so redirects and cookies stay on the
// host that received the request.
export function authBaseFromRequest(req: Request): AuthBase {
  const url = new URL(req.url);
  if (!isTrustedRequestOrigin(url)) {
    const error = new Error(`Auth is not available on ${url.origin}`);
    error.name = "Forbidden";
    throw error;
  }
  return {
    origin: url.origin,
    prefix: req.headers.get("x-app-base") ?? "",
  };
}

export function createAuth(env: Env, authBase: AuthBase) {
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
    baseURL: authBase.origin,
    basePath: `${authBase.prefix}/api/auth`,
    // On the /studio mount the host (spooool.com) runs its own Better Auth
    // with the default cookie names at Path=/. Prefix and path-scope our
    // cookies there so the two apps' sessions can't collide or leak into
    // each other's routes.
    advanced: authBase.prefix
      ? {
          cookiePrefix: "book-cook",
          defaultCookieAttributes: { path: authBase.prefix },
        }
      : undefined,
    trustedOrigins: [
      // The spooool.com/studio vanity route lands here; trust its origin so
      // auth requests initiated from that entry point pass the CSRF check.
      ...STATIC_AUTH_ORIGINS,
      ...LOCAL_AUTH_ORIGINS,
    ],
    emailAndPassword: { enabled: true, autoSignIn: true },
    socialProviders: {
      // Register https://spooool.com/studio/api/auth/callback/google on the
      // Google OAuth client.
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
