import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("auth", () => {
  it("sign-up creates a user and returns a session", async () => {
    const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "correct-horse-battery-staple",
        name: "Alice",
      }),
    });
    expect(res.status).toBeLessThan(400);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/better-auth/);
  });

  it("does not accept server-owned account fields during public sign-up", async () => {
    const email = `account-fields-${crypto.randomUUID()}@example.com`;
    const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "correct-horse-battery-staple",
        name: "Account Fields",
        plan: "free",
        phase: "launch",
        daily_budget_cents: 999_999,
      }),
    });
    expect(res.status).toBeLessThan(400);

    const user = await env.DB.prepare(
      "SELECT plan, phase, daily_budget_cents FROM users WHERE email = ?",
    )
      .bind(email)
      .first<{ plan: string; phase: string; daily_budget_cents: number }>();
    expect(user).toEqual({
      plan: "pro",
      phase: "chassis",
      daily_budget_cents: 5000,
    });
  });
});
