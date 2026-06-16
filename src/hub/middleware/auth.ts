import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { MiddlewareHandler } from "hono";
import { users } from "../db/schema";
import type { Env } from "../env";
import { resolveSpoooolUser } from "../spooool-session";

export type AuthVariables = {
  user: { id: string; email: string; plan: "free" | "pro"; is_admin?: boolean };
};

// Single-worker merge: the studio no longer runs its own Better Auth. Every
// hub request authenticates with spooool's same-origin session — its session
// token (cookie) is looked up in spooool-prod (env.DB) and the matching studio
// user is auto-provisioned by email into env.STUDIO_DB. See
// docs/superpowers/specs/2026-06-15-studio-single-worker-merge-design.md.
type SessionRequestContext = {
  env: Env;
  req: { raw: Request; header: (name: string) => string | undefined };
};

export async function resolveSessionUser(
  c: SessionRequestContext,
): Promise<AuthVariables["user"] | null> {
  const mapped = await resolveSpoooolUser(c.env, c.req.raw.headers);
  return mapped ? (mapped as AuthVariables["user"]) : null;
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
  const db = drizzle(c.env.STUDIO_DB);
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
