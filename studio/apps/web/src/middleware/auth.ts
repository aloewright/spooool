import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { MiddlewareHandler } from "hono";
import { authBaseFromRequest, createAuth } from "../auth";
import { users } from "../db/schema";
import type { Env } from "../env";
import { resolveSpoooolUser } from "../spooool-session";

export type AuthVariables = {
  user: { id: string; email: string; plan: "free" | "pro"; is_admin?: boolean };
};

// One session resolution for every entry point: our own Better Auth session
// first (cookie names depend on the mount, hence authBaseFromRequest), then —
// on the /studio mount only — spooool.com's same-origin session.
type SessionRequestContext = {
  env: Env;
  req: { raw: Request; header: (name: string) => string | undefined };
};

export async function resolveSessionUser(
  c: SessionRequestContext,
): Promise<AuthVariables["user"] | null> {
  const auth = createAuth(c.env, authBaseFromRequest(c.req.raw));
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) return session.user as AuthVariables["user"];
  if (c.req.header("x-app-base")) {
    const mapped = await resolveSpoooolUser(c.env, c.req.raw.headers);
    if (mapped) return mapped as AuthVariables["user"];
  }
  return null;
}

export const requireUser: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const user = await resolveSessionUser(c);
  if (!user) {
    const err = new Error("Unauthorized");
    err.name = "Unauthorized";
    throw err;
  }
  c.set("user", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const user = await resolveSessionUser(c);
  if (!user) {
    const err = new Error("Unauthorized");
    err.name = "Unauthorized";
    throw err;
  }
  const db = drizzle(c.env.DB);
  const row = await db
    .select({ is_admin: users.is_admin })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row[0]?.is_admin) {
    const err = new Error("Forbidden");
    err.name = "Forbidden";
    throw err;
  }
  c.set("user", { ...user, is_admin: true });
  await next();
};
