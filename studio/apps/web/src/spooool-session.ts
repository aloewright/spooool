import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { users } from "./db/schema";
import type { Env } from "./env";

// spooool.com runs its own Better Auth; its session cookie (Path=/) is sent
// with every same-origin request, including our /studio mount. Possession of
// the random 32-char session token is the credential — we look it up in
// spooool's D1 directly (the cookie signature would need spooool's auth
// secret, which we don't hold and don't need). Matching studio users are
// auto-provisioned by email, so signing in on spooool.com is signing in on
// the studio.
const SPOOOOL_COOKIE = "__Secure-better-auth.session_token";

type SpoooolSessionRow = {
  expiresAt: string | number;
  email: string;
  name: string | null;
};

function expiresAtMs(value: string | number): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  return Date.parse(value);
}

export async function resolveSpoooolUser(
  env: Env,
  headers: Headers,
): Promise<typeof users.$inferSelect | null> {
  if (!env.SPOOOOL_DB) return null;
  const cookieHeader = headers.get("cookie") ?? "";
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${SPOOOOL_COOKIE.replace(/[.$]/g, "\\$&")}=([^;.]+)`),
  );
  const token = match?.[1];
  if (!token) return null;

  const row = await env.SPOOOOL_DB.prepare(
    "SELECT s.expiresAt AS expiresAt, u.email AS email, u.name AS name FROM session s JOIN user u ON u.id = s.userId WHERE s.token = ?1 LIMIT 1",
  )
    .bind(token)
    .first<SpoooolSessionRow>();
  if (!row?.email || expiresAtMs(row.expiresAt) <= Date.now()) return null;

  const db = drizzle(env.DB);
  const existing = await db.select().from(users).where(eq(users.email, row.email)).limit(1);
  if (existing[0]) return existing[0];

  await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      name: row.name ?? row.email.split("@")[0],
      email: row.email,
      emailVerified: true,
    })
    .onConflictDoNothing();
  const provisioned = await db.select().from(users).where(eq(users.email, row.email)).limit(1);
  return provisioned[0] ?? null;
}
