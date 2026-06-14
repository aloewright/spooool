import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("market dataset refresh", () => {
  it("writes a weekly JSONL snapshot to R2 and exposes latest health", async () => {
    const refresh = await SELF.fetch("http://x/api/v1/health/market-dataset/refresh", {
      method: "POST",
    });
    expect(refresh.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const body = (await refresh.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.records).toBeGreaterThan(0);
    expect(body.r2Key).toMatch(/^datasets\/\d{4}-W\d{2}\/raw\.jsonl$/);

    const object = await env.R2.get(body.r2Key);
    expect(object).not.toBeNull();
    expect((await object?.text())?.trim().split("\n").length).toBe(body.records);

    const latest = await SELF.fetch("http://x/api/v1/health/market-dataset");
    expect(latest.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const latestBody = (await latest.json()) as any;
    expect(latestBody.ok).toBe(true);
    expect(latestBody.latest.r2_key).toBe(body.r2Key);
  });
});
