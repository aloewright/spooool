import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const spooolDb = (env as unknown as { SPOOOOL_DB: D1Database }).SPOOOOL_DB;

// Minimal mirror of spooool.com's Better Auth tables (it owns the real
// schema; we only read token/expiry/user identity).
async function seedSpoooolSession(opts?: { expired?: boolean }) {
  await spooolDb
    .prepare(
      "CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, createdAt TEXT, updatedAt TEXT)",
    )
    .run();
  await spooolDb
    .prepare(
      "CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, token TEXT, userId TEXT, expiresAt TEXT, createdAt TEXT, updatedAt TEXT)",
    )
    .run();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const token = `tok${suffix}`;
  const email = `sp-${suffix}@x.test`;
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + (opts?.expired ? -1 : 1) * 24 * 60 * 60 * 1000,
  ).toISOString();
  await spooolDb
    .prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, 'Spooool User', ?2, 1, ?3, ?3)",
    )
    .bind(`spu${suffix}`, email, now)
    .run();
  await spooolDb
    .prepare(
      "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(`sps${suffix}`, token, `spu${suffix}`, expiresAt, now)
    .run();
  // Real cookies carry token.signature; only the token half matters to us.
  return { cookie: `__Secure-better-auth.session_token=${token}.c2lnbmF0dXJl`, email };
}

// The app serves under the /studio base path via the spooool.com/studio* zone
// route; the worker strips the prefix before routing (src/index.ts).
describe("spooool.com/studio base path", () => {
  it("serves the API through the prefix", async () => {
    const res = await SELF.fetch("https://spooool.com/studio/api/v1/health");
    expect(res.status).toBe(200);
  });

  it("runs the full auth + API flow through the prefix", async () => {
    const signup = await SELF.fetch("https://spooool.com/studio/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `studio-${crypto.randomUUID()}@x.test`,
        password: "correct-horse-battery-staple",
        name: "W",
      }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie") ?? "";
    expect(cookie).not.toBe("");

    const projects = await SELF.fetch("https://spooool.com/studio/api/v1/projects", {
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(projects.status).toBe(200);
  });

  it("keeps auth error redirects on the prefix", async () => {
    const res = await SELF.fetch("https://spooool.com/studio/api/auth/error?error=test_error", {
      redirect: "manual",
    });
    expect([301, 302]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/studio/sign-in?error=test_error");
  });

  it("ignores a client-supplied base marker on unprefixed requests", async () => {
    const res = await SELF.fetch("https://book-cook.com/api/auth/error?error=spoofed", {
      headers: { "x-app-base": "/studio" },
      redirect: "manual",
    });
    expect([301, 302]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/sign-in?error=spoofed");
  });
});

// The studio used to mount at spooool.com/words; the worker 301s any legacy
// /words path to its /studio equivalent (src/index.ts).
describe("legacy /words redirect", () => {
  it("301-redirects /words paths to /studio, preserving the subpath", async () => {
    const res = await SELF.fetch("https://spooool.com/words/blogs/x", {
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://spooool.com/studio/blogs/x");
  });

  it("preserves the query string and handles the bare /words path", async () => {
    const res = await SELF.fetch("https://spooool.com/words?ref=legacy", {
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://spooool.com/studio?ref=legacy");
  });
});

describe("shared spooool.com session", () => {
  it("signs the studio in from a spooool session and provisions the user", async () => {
    const { cookie, email } = await seedSpoooolSession();

    const session = await SELF.fetch("https://spooool.com/studio/api/v1/session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const body = (await session.json()) as any;
    expect(body.user?.email).toBe(email);

    const projects = await SELF.fetch("https://spooool.com/studio/api/v1/projects", {
      headers: { cookie },
    });
    expect(projects.status).toBe(200);
  });

  it("rejects spooool sessions off the /studio mount", async () => {
    const { cookie } = await seedSpoooolSession();
    const res = await SELF.fetch("https://book-cook.com/api/v1/projects", {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
  });

  it("rejects expired spooool sessions", async () => {
    const { cookie } = await seedSpoooolSession({ expired: true });
    const res = await SELF.fetch("https://spooool.com/studio/api/v1/projects", {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
  });
});
