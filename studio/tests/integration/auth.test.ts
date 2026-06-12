import { SELF } from "cloudflare:test";
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
});
